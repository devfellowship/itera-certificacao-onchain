#!/usr/bin/env bash
# =================================================================================================
# apply-migrations.sh — apply the TMA migrations (db/migrations/*.sql) EXACTLY ONCE, with a ledger.
#
# Target: the TMA Supabase project (mkfnbsnyvfkkfcjfpkxz) through .github/workflows/db-apply.yml,
# or a throwaway Postgres in CI (db/scripts/test-apply-migrations.sh).
# It refuses the DFL prod project (yoojxnggaxcqtsyjdrdx) and the ITERA project (kjefmwlopzeaqgqtlbdn).
#
# Why (plan 20261112-tma-c4-result-store-trajectory-upload, Q-C4-1 079d47f6 = C, Tainan 2026-11-12:
# "first add an apply-on-merge workflow for TMA, then 0023 goes through it"). Until 0023, every
# production apply was by hand (0017-0020, 0021, 0022), and production had no record of what it holds.
# Model: iterahq/itera-player db/scripts/apply-migrations.sh (ledger keyed by file name, checksum,
# stop at the first failure), cut down to what TMA needs.
#
# THE LEDGER: public.tma_schema_migrations, one row per file (filename, sha256, how, by, when).
#   The script creates it (create table if not exists). It is in `public` because the TMA migration
#   role has CREATE on `public` and no CREATE on the database (it cannot create a schema). RLS is on,
#   with no policy, and every grant is revoked from anon, authenticated, service_role and
#   itera_api_service: the API cannot read or write it.
#
# THE BASELINE (one-shot): db/migrations/.baseline lists the files that production received by hand
#   before the ledger existed, each with a read-only probe (one SQL query that returns one boolean).
#   It is read ONLY when the ledger is empty AND the database already has public.runs. Then EVERY
#   probe must return true and the list must be the first N files in order; else exit 3 and nothing
#   is written. A fresh database (no public.runs) ignores the baseline and applies every file.
#
# ONE TRANSACTION PER FILE, LEDGER ROW INCLUDED. A pending file must have no transaction control, or
#   exactly one top-level `begin;` line before exactly one top-level `commit;` line. The script removes
#   those two lines and sends: begin; advisory lock; ledger guard; <file>; insert ledger row; commit;
#   So the DDL and its ledger row commit together, or neither does. Any other shape: exit 2.
#
# STOP AT THE FIRST ERROR (ON_ERROR_STOP). The failed file rolls back; later files do not run.
# IDEMPOTENT: a second `apply` finds 0 pending files and changes nothing. Every migration file must
#   still be idempotent itself (a restore, a fresh environment, a bad baseline).
# CHECKSUM DRIFT: an applied file whose sha256 changed in the repo stops `apply` (exit 3) before any
#   write. `rebaseline FILE --reason TEXT` records the new sum, on purpose, with the reason.
# ORDER: a pending file that sorts before the last applied file stops `apply` (exit 3).
# SCHEMA DIFF: after the apply, `\d` of each table that the applied files create or alter, before and
#   after, as a unified diff (stdout and REPORT_FILE).
#
# Commands:
#   apply                     (default) baseline if needed, then apply the pending files in order
#   plan                      read-only: what `apply` would do
#   status                    read-only: the ledger and the pending files
#   rebaseline FILE --reason TEXT   record the current sha256 of an applied FILE
#
# Environment:
#   TMA_DB_URL         required. A postgres URL. Never printed.
#   TMA_DB_EXPECT_REF  optional. When set, TMA_DB_URL must contain it (the workflow sets
#                      mkfnbsnyvfkkfcjfpkxz).
#   TMA_MIGRATIONS_DIR optional. Default db/migrations (tests point it at fixtures).
#   APPLIED_BY         optional. Default manual:<user>@<host>.
#   REPORT_FILE        optional. The report lines are appended here as well.
#
# Exit codes: 0 ok · 1 a migration failed (stopped there) · 2 usage or environment · 3 drift
#             (baseline probe false, checksum changed, out-of-order file)
# =================================================================================================
set -uo pipefail
export LC_ALL=C

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG_DIR="${TMA_MIGRATIONS_DIR:-${ROOT}/migrations}"
BASELINE_FILE="${MIG_DIR}/.baseline"
LEDGER="public.tma_schema_migrations"
REPORT_FILE="${REPORT_FILE:-}"

say()  { printf '[db-apply] %s\n' "$*"; }
rep()  { say "$*"; if [[ -n "$REPORT_FILE" ]]; then printf '%s\n' "$*" >> "$REPORT_FILE"; fi; return 0; }
die()  { printf '[db-apply] ERROR: %s\n' "$1" >&2; if [[ -n "$REPORT_FILE" ]]; then printf 'ERROR: %s\n' "$1" >> "$REPORT_FILE"; fi; exit "${2:-2}"; }

CMD="apply"; TARGET=""; REASON=""
case "${1:-}" in
  apply|plan|status|rebaseline) CMD="$1"; shift ;;
  -h|--help) sed -n '2,56p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  "") ;;
  *) die "unknown command '$1' (see --help)" ;;
esac
while [[ $# -gt 0 ]]; do
  case "$1" in
    --reason) REASON="${2:-}"; shift 2 ;;
    -*) die "unknown flag '$1'" ;;
    *) TARGET="$1"; shift ;;
  esac
done

# -- connection and guardrails ---------------------------------------------------------------------
[[ -n "${TMA_DB_URL:-}" ]] || die "TMA_DB_URL is empty. Nothing was read or applied."
case "$TMA_DB_URL" in
  *yoojxnggaxcqtsyjdrdx*) die "REFUSED: that is the DFL prod project. TMA migrations never touch it." ;;
  *kjefmwlopzeaqgqtlbdn*) die "REFUSED: that is the ITERA project. TMA migrations never touch it." ;;
esac
if [[ -n "${TMA_DB_EXPECT_REF:-}" && "$TMA_DB_URL" != *"$TMA_DB_EXPECT_REF"* ]]; then
  die "REFUSED: TMA_DB_URL does not name the expected project ref ${TMA_DB_EXPECT_REF}."
fi
command -v psql >/dev/null 2>&1 || die "psql not found on PATH"
[[ -d "$MIG_DIR" ]] || die "no migrations directory at $MIG_DIR"
APPLIED_BY="${APPLIED_BY:-manual:$(id -un 2>/dev/null || echo unknown)@$(hostname -s 2>/dev/null || echo unknown)}"

q()   { psql "$TMA_DB_URL" -v ON_ERROR_STOP=1 -qtAX -c "$1"; }
lit() { printf "%s" "${1//\'/\'\'}"; }
sum_of() { sha256sum "$1" | cut -d' ' -f1; }
mig_files() { local f; for f in "$MIG_DIR"/*.sql; do [[ -e "$f" ]] && basename "$f"; done | sort; }

q "select 1" >/dev/null || die "cannot connect to the database (the URL is not printed)."

ledger_exists() { [[ "$(q "select to_regclass('$LEDGER') is not null")" == "t" ]]; }

ensure_ledger() {
  psql "$TMA_DB_URL" -v ON_ERROR_STOP=1 -qX >/dev/null <<SQL || die "could not create the ledger $LEDGER"
set client_min_messages = warning;
create table if not exists $LEDGER (
  filename    text primary key check (filename ~ '^[0-9]{4}_[a-z0-9_]+\.sql\$'),
  checksum    text not null check (checksum ~ '^[0-9a-f]{64}\$'),
  how         text not null check (how in ('applied', 'baseline', 'rebaseline')),
  applied_by  text not null check (char_length(applied_by) between 1 and 200),
  applied_at  timestamptz not null default now(),
  duration_ms integer,
  note        text check (note is null or char_length(note) <= 500)
);
comment on table $LEDGER is
  'TMA migration ledger, written only by db/scripts/apply-migrations.sh (one row per applied db/migrations file). Not for the API.';
alter table $LEDGER enable row level security;
do \$\$
declare r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role', 'itera_api_service'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on table $LEDGER from %I', r);
    end if;
  end loop;
end \$\$;
SQL
}

declare -A LEDGER_SUM=()
load_ledger() {
  LEDGER_SUM=()
  ledger_exists || return 0
  local fn cs
  while IFS='|' read -r fn cs; do
    [[ -n "$fn" ]] && LEDGER_SUM["$fn"]="$cs"
  done < <(q "select filename, checksum from $LEDGER order by filename")
}

# -- the one-shot baseline ---------------------------------------------------------------------------
BASELINE_NAMES=(); BASELINE_PROBES=()
read_baseline() {
  BASELINE_NAMES=(); BASELINE_PROBES=()
  [[ -f "$BASELINE_FILE" ]] || return 0
  local line name probe
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "${line// }" || "$line" == \#* ]] && continue
    name="${line%%|*}"; probe="${line#*|}"
    name="${name// /}"
    [[ "$name" =~ ^[0-9]{4}_[a-z0-9_]+\.sql$ && "$probe" != "$line" && -n "$probe" ]] \
      || die "bad line in $BASELINE_FILE: '$line' (format: <file>|<select returning one boolean>)" 2
    BASELINE_NAMES+=("$name"); BASELINE_PROBES+=("$probe")
  done < "$BASELINE_FILE"
}

# Prints "fresh", "baseline" or "ledger".
baseline_mode() {
  if [[ ${#LEDGER_SUM[@]} -gt 0 ]]; then echo ledger; return; fi
  if [[ "$(q "select to_regclass('public.runs') is null")" == "t" ]]; then echo fresh; return; fi
  echo baseline
}

# Checks every probe and the prefix rule. Exit 3 on any failure. Writes nothing.
check_baseline() {
  read_baseline
  [[ ${#BASELINE_NAMES[@]} -gt 0 ]] || die "the ledger is empty, the database is not fresh (public.runs exists), and $BASELINE_FILE lists no file. Refusing to guess what production holds." 3
  local all=() i bad=0 got
  mapfile -t all < <(mig_files)
  for i in "${!BASELINE_NAMES[@]}"; do
    [[ "${all[$i]:-}" == "${BASELINE_NAMES[$i]}" ]] \
      || die "baseline line $((i + 1)) is ${BASELINE_NAMES[$i]}, but file $((i + 1)) in order is ${all[$i]:-<none>}. The baseline must be the first files in order." 3
    got="$(q "${BASELINE_PROBES[$i]}" 2>&1)" || got="error: ${got}"
    if [[ "$got" == "t" ]]; then
      say "baseline probe ok    ${BASELINE_NAMES[$i]}"
    else
      rep "baseline probe FALSE ${BASELINE_NAMES[$i]} -> ${got}"
      bad=1
    fi
  done
  [[ $bad -eq 0 ]] || die "a baseline probe is false: this database does not hold what $BASELINE_FILE claims. Nothing was written." 3
}

write_baseline() {
  local sql="begin; select pg_advisory_xact_lock(hashtext('tma-db-apply'));" i
  for i in "${!BASELINE_NAMES[@]}"; do
    sql+=" insert into $LEDGER (filename, checksum, how, applied_by, note) values ('$(lit "${BASELINE_NAMES[$i]}")', '$(sum_of "$MIG_DIR/${BASELINE_NAMES[$i]}")', 'baseline', '$(lit "$APPLIED_BY")', 'applied by hand before the ledger existed; probe held at baseline time');"
  done
  sql+=" commit;"
  psql "$TMA_DB_URL" -v ON_ERROR_STOP=1 -qX -c "$sql" >/dev/null || die "could not write the baseline rows" 1
  rep "baseline: recorded ${#BASELINE_NAMES[@]} file(s) as applied by hand (${BASELINE_NAMES[0]} .. ${BASELINE_NAMES[-1]}), not executed"
}

# -- drift and pending -----------------------------------------------------------------------------
PENDING=()
compute_pending() {
  PENDING=()
  local f last="" drift=0
  for f in "${!LEDGER_SUM[@]}"; do [[ "$f" > "$last" ]] && last="$f"; done
  while IFS= read -r f; do
    if [[ -n "${LEDGER_SUM[$f]:-}" ]]; then
      if [[ "${LEDGER_SUM[$f]}" != "$(sum_of "$MIG_DIR/$f")" ]]; then
        rep "CHECKSUM DRIFT $f: the file changed after it was applied (ledger ${LEDGER_SUM[$f]:0:12}, file $(sum_of "$MIG_DIR/$f" | cut -c1-12))"
        drift=1
      fi
    else
      if [[ -n "$last" && "$f" < "$last" ]]; then
        rep "OUT OF ORDER $f: pending, but it sorts before the last applied file $last"
        drift=1
      fi
      PENDING+=("$f")
    fi
  done < <(mig_files)
  for f in "${!LEDGER_SUM[@]}"; do
    [[ -e "$MIG_DIR/$f" ]] || say "note: $f is in the ledger but not in $MIG_DIR"
  done
  return $drift
}

# -- one file, one transaction ---------------------------------------------------------------------
TXRE_BEGIN='^[[:space:]]*[Bb][Ee][Gg][Ii][Nn][[:space:]]*;[[:space:]]*(--.*)?$'
TXRE_COMMIT='^[[:space:]]*[Cc][Oo][Mm][Mm][Ii][Tt][[:space:]]*;[[:space:]]*(--.*)?$'
TXRE_OTHER='^[[:space:]]*([Rr][Oo][Ll][Ll][Bb][Aa][Cc][Kk]|[Ss][Tt][Aa][Rr][Tt][[:space:]]+[Tt][Rr][Aa][Nn][Ss][Aa][Cc][Tt][Ii][Oo][Nn]|[Bb][Ee][Gg][Ii][Nn][[:space:]]+([Tt][Rr][Aa][Nn][Ss][Aa][Cc][Tt][Ii][Oo][Nn]|[Ww][Oo][Rr][Kk])|[Cc][Oo][Mm][Mm][Ii][Tt][[:space:]]+([Tt][Rr][Aa][Nn][Ss][Aa][Cc][Tt][Ii][Oo][Nn]|[Ww][Oo][Rr][Kk]))[[:space:]]*;'

# Validates the transaction shape of a file. Prints nothing; returns 0 when it is one of the two allowed shapes.
tx_shape_ok() {
  local file="$1" nb nc lb lc
  grep -Eq "$TXRE_OTHER" "$file" && return 1
  nb=$(grep -Ec "$TXRE_BEGIN" "$file"); nc=$(grep -Ec "$TXRE_COMMIT" "$file")
  [[ $nb -eq 0 && $nc -eq 0 ]] && return 0
  [[ $nb -eq 1 && $nc -eq 1 ]] || return 1
  lb=$(grep -En "$TXRE_BEGIN" "$file" | cut -d: -f1); lc=$(grep -En "$TXRE_COMMIT" "$file" | cut -d: -f1)
  [[ $lb -lt $lc ]]
}

apply_one() {
  local f="$1" path="$MIG_DIR/$1" sum t0 t1 ms
  tx_shape_ok "$path" || die "$f: a pending file must be one transaction (no transaction control, or one top-level 'begin;' before one top-level 'commit;'). Nothing from $f was applied." 2
  sum="$(sum_of "$path")"
  t0=$(date +%s%3N)
  {
    printf 'set client_min_messages = warning;\nbegin;\n'
    printf "select pg_advisory_xact_lock(hashtext('tma-db-apply'));\n"
    printf "do \$tma\$ begin if exists (select 1 from %s where filename = '%s') then raise exception '%s is already in the ledger (a concurrent apply?)'; end if; end \$tma\$;\n" "$LEDGER" "$(lit "$f")" "$(lit "$f")"
    printf -- '-- ---- %s ----\n' "$f"
    grep -Ev "$TXRE_BEGIN|$TXRE_COMMIT" "$path"
    printf '\n-- ---- end %s ----\n' "$f"
    printf "insert into %s (filename, checksum, how, applied_by, duration_ms) values ('%s', '%s', 'applied', '%s', null);\n" \
      "$LEDGER" "$(lit "$f")" "$sum" "$(lit "$APPLIED_BY")"
    printf 'commit;\n'
  } | psql "$TMA_DB_URL" -v ON_ERROR_STOP=1 -qX -f - >/dev/null
  local rc=$?
  t1=$(date +%s%3N); ms=$((t1 - t0))
  if [[ $rc -ne 0 ]]; then
    rep "FAILED  $f (psql exit $rc). Its transaction rolled back. Later files were NOT applied."
    return 1
  fi
  q "update $LEDGER set duration_ms = $ms where filename = '$(lit "$f")' and duration_ms is null" >/dev/null || true
  rep "applied $f (${ms} ms, sha256 ${sum:0:12})"
}

# -- schema diff -----------------------------------------------------------------------------------
touched_tables() {
  local f
  for f in "$@"; do
    grep -Eio '(create|alter)[[:space:]]+table[[:space:]]+(if[[:space:]]+(not[[:space:]]+)?exists[[:space:]]+)?(only[[:space:]]+)?(public\.)?[a-z_][a-z0-9_]*' "$MIG_DIR/$f" \
      | sed -E 's/.*[[:space:]](public\.)?([a-z_][a-z0-9_]*)$/\2/I' | tr 'A-Z' 'a-z'
  done | grep -Ev '^(if|only|not|exists)$' | sort -u
}
describe_tables() {
  local t
  for t in "$@"; do
    printf '=== public.%s\n' "$t"
    if [[ "$(q "select to_regclass('public.$t') is not null")" == "t" ]]; then
      psql "$TMA_DB_URL" -X -P pager=off -c "\\d public.$t" 2>&1 | sed '1{/^$/d}'
    else
      printf '(absent)\n'
    fi
  done
}

# -- commands --------------------------------------------------------------------------------------
case "$CMD" in
  status|plan)
    load_ledger
    mode="$(baseline_mode)"
    say "ledger rows: ${#LEDGER_SUM[@]} · mode: $mode · files: $(mig_files | wc -l)"
    if [[ "$mode" == "baseline" ]]; then
      check_baseline
      for n in "${BASELINE_NAMES[@]}"; do LEDGER_SUM["$n"]="$(sum_of "$MIG_DIR/$n")"; done
      say "apply would first record ${#BASELINE_NAMES[@]} baseline file(s) without running them"
    fi
    compute_pending; drift=$?
    if [[ ${#PENDING[@]} -eq 0 ]]; then say "pending: none"; else for f in "${PENDING[@]}"; do say "pending: $f"; done; fi
    [[ "$CMD" == "status" ]] && ledger_exists && q "select filename || '  ' || how || '  ' || left(checksum, 12) || '  ' || to_char(applied_at, 'YYYY-MM-DD HH24:MI') || '  ' || applied_by from $LEDGER order by filename"
    [[ $drift -eq 0 ]] || exit 3
    exit 0
    ;;

  rebaseline)
    [[ -n "$TARGET" && -n "$REASON" ]] || die "usage: rebaseline FILE --reason TEXT"
    [[ -f "$MIG_DIR/$TARGET" ]] || die "no file $MIG_DIR/$TARGET"
    load_ledger
    [[ -n "${LEDGER_SUM[$TARGET]:-}" ]] || die "$TARGET is not in the ledger: nothing to rebaseline"
    q "update $LEDGER set checksum = '$(sum_of "$MIG_DIR/$TARGET")', how = 'rebaseline', applied_by = '$(lit "$APPLIED_BY")', note = left('$(lit "$REASON")', 500) where filename = '$(lit "$TARGET")'" >/dev/null \
      || die "could not update the ledger row of $TARGET" 1
    rep "rebaseline $TARGET: the ledger now records the current sha256 (reason: $REASON)"
    exit 0
    ;;

  apply)
    load_ledger
    mode="$(baseline_mode)"
    rep "db-apply · by $APPLIED_BY · ledger rows ${#LEDGER_SUM[@]} · mode $mode"
    if [[ "$mode" == "baseline" ]]; then
      check_baseline
    fi
    ensure_ledger
    if [[ "$mode" == "baseline" ]]; then
      write_baseline
      load_ledger
    fi
    compute_pending || die "drift found (see above). Nothing was applied." 3
    if [[ ${#PENDING[@]} -eq 0 ]]; then
      rep "pending: none. Nothing to apply (ledger rows: ${#LEDGER_SUM[@]})."
      exit 0
    fi
    rep "pending: ${PENDING[*]}"
    for f in "${PENDING[@]}"; do
      tx_shape_ok "$MIG_DIR/$f" || die "$f: a pending file must be one transaction (no transaction control, or one top-level 'begin;' before one top-level 'commit;'). Nothing was applied." 2
    done

    mapfile -t TABLES < <(touched_tables "${PENDING[@]}")
    tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
    [[ ${#TABLES[@]} -gt 0 ]] && describe_tables "${TABLES[@]}" > "$tmp/before.txt"

    applied=0; failed=0
    for f in "${PENDING[@]}"; do
      if apply_one "$f"; then applied=$((applied + 1)); else failed=1; break; fi
    done

    if [[ ${#TABLES[@]} -gt 0 ]]; then
      describe_tables "${TABLES[@]}" > "$tmp/after.txt"
      rep "schema diff (\\d before -> after) of: ${TABLES[*]}"
      d="$(diff -u --label before --label after "$tmp/before.txt" "$tmp/after.txt")"
      if [[ -z "$d" ]]; then rep "(no change in \\d output)"; else printf '%s\n' "$d"; [[ -n "$REPORT_FILE" ]] && printf '%s\n' "$d" >> "$REPORT_FILE"; fi
    fi

    rep "result: applied $applied file(s)$([[ $failed -eq 1 ]] && echo ', then STOPPED at the first failure')"
    [[ $failed -eq 0 ]] || exit 1
    exit 0
    ;;
esac
