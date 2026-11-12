#!/usr/bin/env bash
# test-apply-migrations.sh — proves db/scripts/apply-migrations.sh against a THROWAWAY Postgres.
# Run by .github/workflows/db-apply.yml (job `rehearse`) on every PR and before every production apply.
# Needs no credential. Never point it at a real project: it creates and drops databases.
#
#   PG_ADMIN_URL=postgresql://postgres:postgres@127.0.0.1:5432/postgres bash db/scripts/test-apply-migrations.sh
#
# Scenarios (each on its own new database):
#   A fresh       every file applies in order; a second apply applies 0; the ledger has one row per file.
#   B prod-shape  the .baseline files are applied BY HAND first (as production was); apply records them as
#                 `baseline` without running them and applies only the files after them; a re-run applies 0.
#   C bad-base    only part of the baseline is applied by hand; apply exits 3 and writes no ledger row.
#   D stop        a failing file in the middle: exit 1, its partial DDL rolled back, no ledger row for it,
#                 the file after it not applied.
#   E drift       an applied file changes: apply exits 3 and applies nothing; rebaseline clears it.
#   F tx-shape    a pending file with two `commit;` lines is refused (exit 2) before any write.
#   G refuse      a URL that names the DFL prod or the ITERA project is refused (exit 2) before connecting.
set -euo pipefail
export LC_ALL=C

: "${PG_ADMIN_URL:?set PG_ADMIN_URL to a throwaway Postgres superuser URL}"
case "$PG_ADMIN_URL" in
  *supabase.co*) echo "REFUSED: PG_ADMIN_URL must be a throwaway Postgres, not a Supabase project" >&2; exit 2 ;;
esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APPLY="$ROOT/db/scripts/apply-migrations.sh"
PRE="$ROOT/scripts/e2e/hermetic/db-pre.sql"
MIG="$ROOT/db/migrations"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
export APPLIED_BY="ci:test-apply-migrations"

base="${PG_ADMIN_URL%/*}"
url_of() { printf '%s/%s' "$base" "$1"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
ok()   { echo "ok   $*"; }
newdb() {
  psql "$PG_ADMIN_URL" -qX -v ON_ERROR_STOP=1 -c "drop database if exists $1" -c "create database $1" >/dev/null
  psql "$(url_of "$1")" -qX -v ON_ERROR_STOP=1 -f "$PRE" >/dev/null
}
sql() { psql "$(url_of "$1")" -qtAX -v ON_ERROR_STOP=1 -c "$2"; }
run_apply() { # db, args... ; prints output to $WORK/out, returns the exit code
  local db="$1"; shift
  set +e; TMA_DB_URL="$(url_of "$db")" bash "$APPLY" "$@" > "$WORK/out" 2>&1; local rc=$?; set -e
  sed 's/^/     | /' "$WORK/out"
  return $rc
}
expect_rc() { # want, db, args...
  local want="$1"; shift
  local rc=0; run_apply "$@" || rc=$?
  [[ $rc -eq $want ]] || fail "apply $* exited $rc, expected $want"
}

n_files=$(ls "$MIG"/*.sql | wc -l)
mapfile -t BASE < <(grep -Ev '^[[:space:]]*(#|$)' "$MIG/.baseline" | cut -d'|' -f1)
n_base=${#BASE[@]}
[[ $n_base -gt 0 && $n_base -lt $n_files ]] || fail "expected a baseline shorter than the file list ($n_base of $n_files)"

# -- A fresh -----------------------------------------------------------------------------------------
echo "== A fresh database"
newdb tma_a
expect_rc 0 tma_a apply
[[ "$(sql tma_a "select count(*) from public.tma_schema_migrations where how = 'applied'")" == "$n_files" ]] || fail "A: ledger rows != $n_files"
grep -q "result: applied $n_files file(s)" "$WORK/out" || fail "A: first apply did not report $n_files files"
ok "A: $n_files files applied in order"
expect_rc 0 tma_a apply
grep -q "pending: none" "$WORK/out" || fail "A: second apply was not a no-op"
ok "A: second apply applied 0 (idempotent)"
expect_rc 0 tma_a plan
grep -q "pending: none" "$WORK/out" || fail "A: plan shows pending files"
[[ "$(sql tma_a "select count(*) from information_schema.role_table_grants where table_name = 'tma_schema_migrations' and grantee in ('anon','authenticated','service_role','itera_api_service')")" == "0" ]] || fail "A: an API role has a grant on the ledger"
[[ "$(sql tma_a "select relrowsecurity from pg_class where oid = 'public.tma_schema_migrations'::regclass")" == "t" ]] || fail "A: RLS is off on the ledger"
ok "A: the ledger has RLS on and no API-role grant"

# -- B production shape --------------------------------------------------------------------------------
echo "== B production shape: baseline files applied by hand first"
newdb tma_b
for f in "${BASE[@]}"; do psql "$(url_of tma_b)" -qX -v ON_ERROR_STOP=1 -f "$MIG/$f" >/dev/null; done
before_runs=$(sql tma_b "select count(*) from public.runs")
expect_rc 0 tma_b apply
[[ "$(sql tma_b "select count(*) from public.tma_schema_migrations where how = 'baseline'")" == "$n_base" ]] || fail "B: baseline rows != $n_base"
[[ "$(sql tma_b "select count(*) from public.tma_schema_migrations where how = 'applied'")" == "$((n_files - n_base))" ]] || fail "B: applied rows != $((n_files - n_base))"
grep -q "schema diff" "$WORK/out" || fail "B: no schema diff in the output"
grep -Eq '^\+' "$WORK/out" || fail "B: the schema diff is empty"
[[ "$(sql tma_b "select count(*) from public.runs")" == "$before_runs" ]] || fail "B: row count of runs changed"
ok "B: $n_base baseline rows recorded without running them, $((n_files - n_base)) file(s) applied, \\d diff printed"
expect_rc 0 tma_b apply
grep -q "pending: none" "$WORK/out" || fail "B: re-run was not a no-op"
ok "B: re-run applied 0"

# -- C a baseline that does not hold ---------------------------------------------------------------------
echo "== C partial hand-applied state: the baseline must refuse"
newdb tma_c
half=$((n_base / 2))
for f in "${BASE[@]:0:$half}"; do psql "$(url_of tma_c)" -qX -v ON_ERROR_STOP=1 -f "$MIG/$f" >/dev/null; done
expect_rc 3 tma_c apply
[[ "$(sql tma_c "select to_regclass('public.tma_schema_migrations') is null")" == "t" ]] || fail "C: the ledger was created on a refused baseline"
ok "C: refused (exit 3), no ledger written"

# -- D stop at the first error ---------------------------------------------------------------------------
echo "== D a failing file in the middle"
mkdir -p "$WORK/d"
cp "$MIG"/0000_*.sql "$MIG"/0001_*.sql "$WORK/d/"
cat > "$WORK/d/0002_boom.sql" <<'SQL'
begin;
create table if not exists public.boom_marker (id int);
select 1 / 0;
commit;
SQL
printf 'create table if not exists public.after_marker (id int);\n' > "$WORK/d/0003_after.sql"
newdb tma_d
TMA_MIGRATIONS_DIR="$WORK/d" expect_rc 1 tma_d apply
[[ "$(sql tma_d "select string_agg(filename, ',' order by filename) from public.tma_schema_migrations")" == "0000_baseline.sql,0001_runs_async.sql" ]] || fail "D: the ledger does not hold exactly the two files before the failure"
[[ "$(sql tma_d "select to_regclass('public.boom_marker') is null and to_regclass('public.after_marker') is null")" == "t" ]] || fail "D: the failed file was not rolled back, or the next file ran"
ok "D: stopped at 0002 (exit 1), its DDL rolled back, 0003 not applied"

# -- E checksum drift -------------------------------------------------------------------------------------
echo "== E an applied file changes"
printf '\n-- edited after apply\n' >> "$WORK/d/0001_runs_async.sql"
rm "$WORK/d/0002_boom.sql"
TMA_MIGRATIONS_DIR="$WORK/d" expect_rc 3 tma_d apply
grep -q "CHECKSUM DRIFT 0001_runs_async.sql" "$WORK/out" || fail "E: drift not named"
[[ "$(sql tma_d "select to_regclass('public.after_marker') is null")" == "t" ]] || fail "E: a file was applied despite drift"
ok "E: drift refused (exit 3), nothing applied"
TMA_MIGRATIONS_DIR="$WORK/d" expect_rc 0 tma_d rebaseline 0001_runs_async.sql --reason "test: comment-only edit"
TMA_MIGRATIONS_DIR="$WORK/d" expect_rc 0 tma_d apply
[[ "$(sql tma_d "select to_regclass('public.after_marker') is not null")" == "t" ]] || fail "E: 0003 not applied after rebaseline"
ok "E: rebaseline recorded the reason; the next apply ran 0003"

# -- F transaction shape -----------------------------------------------------------------------------------
echo "== F a pending file with two commits"
printf 'begin;\ncreate table public.f1 (id int);\ncommit;\ncreate table public.f2 (id int);\ncommit;\n' > "$WORK/d/0004_two_commits.sql"
TMA_MIGRATIONS_DIR="$WORK/d" expect_rc 2 tma_d apply
[[ "$(sql tma_d "select to_regclass('public.f1') is null and to_regclass('public.f2') is null")" == "t" ]] || fail "F: a two-commit file ran"
ok "F: refused (exit 2) before any write"

# -- G guardrails --------------------------------------------------------------------------------------------
echo "== G refused targets"
for bad in "postgresql://u:p@db.yoojxnggaxcqtsyjdrdx.supabase.co:5432/postgres" "postgresql://u:p@aws-1-us-east-1.pooler.supabase.com:5432/postgres?x=kjefmwlopzeaqgqtlbdn"; do
  set +e; TMA_DB_URL="$bad" bash "$APPLY" plan > "$WORK/out" 2>&1; rc=$?; set -e
  [[ $rc -eq 2 ]] && grep -q REFUSED "$WORK/out" || fail "G: a forbidden project was not refused (exit $rc)"
done
set +e; TMA_DB_URL="$(url_of tma_a)" TMA_DB_EXPECT_REF=mkfnbsnyvfkkfcjfpkxz bash "$APPLY" plan > "$WORK/out" 2>&1; rc=$?; set -e
[[ $rc -eq 2 ]] && grep -q REFUSED "$WORK/out" || fail "G: a URL without the expected ref was not refused"
ok "G: DFL prod, ITERA and a wrong ref are refused (exit 2)"

for db in tma_a tma_b tma_c tma_d; do psql "$PG_ADMIN_URL" -qX -c "drop database if exists $db" >/dev/null; done
echo "ALL SCENARIOS PASSED"
