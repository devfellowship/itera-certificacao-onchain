# ITERA GitHub App (read-only agent connector)

ADR-2 of plan `20261012-itera-agent-proof-route-change-fixes`: users install a read-only GitHub App
on the repos that hold their agents. The API (`apps/api/src/http/github-router.ts`) reads
`AGENTS.md`, `CLAUDE.md` and `skills/**` at a pinned commit.

App definition (`manifest.json`): `Contents: read` + `Metadata: read` only, no webhook, public,
user authorization on install (the OAuth `code` proves that the caller can see the installation).

## Create the App (once, needs an org admin in a browser)

1. Open `create-app.html` (hosted copy: see the PR) and click **Create the App on GitHub**, then
   **Create GitHub App** on the GitHub page.
2. GitHub redirects to `https://itera-agent-credentials.devfellowship.com/connect/github/app-created?code=...`.
   Copy that full URL (the page itself can 404). The code expires in 1 hour and works once.
3. Convert and store (claude-main, with the Infisical admin token, never printed):
   `INFISICAL_TOKEN=... scripts/github-app/convert-manifest-code.sh '<url or code>'`
   It stores `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`,
   `GITHUB_APP_PRIVATE_KEY` (base64 PEM) under `/apps/itera-agent-credentials/`.
4. Add those env vars to the Dokploy API app and redeploy. Until then the GitHub routes answer 503.

## Install flow

`GET /github/install-url` (wallet session) → `https://github.com/apps/<slug>/installations/new?state=<signed>`.
After install + authorize, GitHub redirects the browser to the web route `/connect/github/callback`
with `installation_id`, `code`, `setup_action` (and `state` when GitHub keeps it). That page calls
`GET <api>/github/callback?installation_id=..&code=..&state=..` with the session Bearer token.
