#!/usr/bin/env bash
# Converts a GitHub App Manifest `code` into the App credentials and stores them in Infisical.
#
# Usage:
#   INFISICAL_TOKEN=<admin token> ./convert-manifest-code.sh <code | full redirect URL>
#
# Env:
#   INFISICAL_TOKEN        Infisical token with write access to the path (required; never printed)
#   INFISICAL_API_URL      default https://infisical.devfellowship.com
#   INFISICAL_PROJECT_ID   default f9572f70-c99d-4a44-8686-e9e83ff5a8fe (personal-vaults-tainan)
#   INFISICAL_ENV          default prod
#   INFISICAL_SECRET_PATH  default /apps/itera-agent-credentials
#   DRY_RUN=1              convert nothing; only check the arguments
#
# Writes GITHUB_APP_ID, GITHUB_APP_SLUG, GITHUB_APP_CLIENT_ID, GITHUB_APP_CLIENT_SECRET,
# GITHUB_APP_WEBHOOK_SECRET (when GitHub returns one), GITHUB_APP_PRIVATE_KEY (base64 of the PEM).
# The conversion is ONE-TIME: GitHub never shows the private key again. Nothing is written to disk
# and no secret value is printed — only names, the app id and the slug.
set -euo pipefail

arg="${1:-}"
[[ -z "$arg" ]] && { sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 3; }
code="$arg"
if [[ "$arg" == *"code="* ]]; then code="$(sed -E 's/.*[?&]code=([^&#]+).*/\1/' <<<"$arg")"; fi
[[ "$code" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "error: could not parse a manifest code" >&2; exit 3; }
: "${INFISICAL_TOKEN:?INFISICAL_TOKEN is required}"
[[ "${DRY_RUN:-0}" == "1" ]] && { echo "dry run: code parsed (${code:0:4}...), token present"; exit 0; }

API="${INFISICAL_API_URL:-https://infisical.devfellowship.com}"
export PID="${INFISICAL_PROJECT_ID:-f9572f70-c99d-4a44-8686-e9e83ff5a8fe}"
export ENVV="${INFISICAL_ENV:-prod}"
export SP="${INFISICAL_SECRET_PATH:-/apps/itera-agent-credentials}"

# The response holds the PEM: keep it in a shell variable only, never on disk.
conversion="$(curl -sS -f -X POST -H "Accept: application/vnd.github+json" \
  "https://api.github.com/app-manifests/${code}/conversions")" || {
  echo "error: GitHub conversion failed (code expired after 1 h, or already used)" >&2; exit 1; }

pairs="$(CONV="$conversion" python3 -c '
import base64, json, os
c = json.loads(os.environ["CONV"])
out = {
  "GITHUB_APP_ID": str(c["id"]),
  "GITHUB_APP_SLUG": c["slug"],
  "GITHUB_APP_CLIENT_ID": c["client_id"],
  "GITHUB_APP_CLIENT_SECRET": c["client_secret"],
  "GITHUB_APP_PRIVATE_KEY": base64.b64encode(c["pem"].encode()).decode(),
}
if c.get("webhook_secret"):
  out["GITHUB_APP_WEBHOOK_SECRET"] = c["webhook_secret"]
print(json.dumps(out))')"
conversion=""

echo "app created: id=$(PAIRS="$pairs" python3 -c 'import json,os;print(json.loads(os.environ["PAIRS"])["GITHUB_APP_ID"])') slug=$(PAIRS="$pairs" python3 -c 'import json,os;print(json.loads(os.environ["PAIRS"])["GITHUB_APP_SLUG"])')"

fail=0
for name in $(PAIRS="$pairs" python3 -c 'import json,os;print(" ".join(json.loads(os.environ["PAIRS"])))'); do
  body="$(PAIRS="$pairs" NAME="$name" python3 -c '
import json, os
print(json.dumps({"secretValue": json.loads(os.environ["PAIRS"])[os.environ["NAME"]],
  "workspaceId": os.environ["PID"], "environment": os.environ["ENVV"], "secretPath": os.environ["SP"], "type": "shared"}))')"
  # Create; when the secret already exists, update it.
  code_http="$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$API/api/v3/secrets/raw/$name" \
    -H "Authorization: Bearer $INFISICAL_TOKEN" -H "Content-Type: application/json" --data "$body" || echo 000)"
  if [[ "$code_http" != "200" ]]; then
    code_http="$(curl -sS -o /dev/null -w '%{http_code}' -X PATCH "$API/api/v3/secrets/raw/$name" \
      -H "Authorization: Bearer $INFISICAL_TOKEN" -H "Content-Type: application/json" --data "$body" || echo 000)"
  fi
  body=""
  if [[ "$code_http" == "200" ]]; then echo "  stored $SP/$name"; else echo "  FAILED $SP/$name (HTTP $code_http)" >&2; fail=1; fi
done
pairs=""
if [[ "$fail" != "0" ]]; then
  echo "error: some secrets were not stored. The private key is NOT recoverable from GitHub;" >&2
  echo "generate a new one in the App settings (Private keys) and store it by hand." >&2
  exit 1
fi
echo "done. Wire GITHUB_APP_* + ITERA_SESSION_SECRET into the Dokploy API app env, then redeploy."
