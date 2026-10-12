# TestMyAgent

Product name: TestMyAgent. Internal identifiers keep the old name on purpose: `ITERA_*` env vars, package names (`@itera/*`), DB roles, the on-chain Credential, Schema and Memo prefixes (`itera-run:v1`, `itera-eval:v1`), the GitHub App slug, and the `itera-agent-credentials*` domains.

This repository holds the coding-agent evaluation proof of concept for the Colosseum hackathon. The current web app is a planning preview. It does not yet run evaluations or write proofs to Solana.

## Workspace

- `apps/web`: Vite, React, and TypeScript web application.
- `apps/api`: Express API in TypeScript, backing the testmyagent.com entity model (vendor proves
  one task to one buyer — see `03_produto_mvp_72h.pdf` from the 2026-10-11 pivot doc, the reference
  for every route/field name below). `PORT` sets the port (default `3000`).
  - `GET /`: service status as JSON. `GET /health`: minimal liveness check, used by the Dockerfile
    `HEALTHCHECK`, not rate-limited or CORS-gated. `GET /hello-world`: plain text.
  - **Retired (410 Gone)**: the first vendor-endpoint flow (`POST /evaluations` with an
    `idempotencyKey` body, `POST /evaluations/:id/dispatch`, `GET /evaluations/:id/events`,
    `POST /evaluations/:id/publish`, `POST /agent-endpoint-manifests`). It graded the vendor's
    patch as a local process inside the API container, outside the grader sandbox. These routes
    now answer `410` with a pointer to the new flow (`apps/api/src/http/legacy-gone-router.ts`).
    The new flow is evaluations v2 (`POST /evaluations/quote`, pay, `POST /evaluations`
    with `reference` + `txSig`, `GET /evaluations/:id`): the runner runs the agent and a separate
    no-network container runs the grader. The API image carries no evaluator and no `benchmarks/`.
  - **Buyer-side, public and read-only**: `GET /credentials/:id`, `GET /credentials/:id/verify`
    (recomputes the manifest digest for real, AND reads the real on-chain attestation via
    `apps/api/src/domain/solana-attestation.ts`'s `verifyOnChain` — confirms program owner,
    credential, and schema against known devnet addresses, decodes the attestation's own bytes
    against the live Schema account; `unavailable` only when no attestation was ever issued for
    that claim, never faked as passing), `GET /credentials/:id/export`.
  - **Public intake**: `POST /evaluation-requests` ("Solicitar teste na minha tarefa" — contact +
    free-text description only, no code/secret fields). Also commits the task description as a
    `.md` file to the public `D0ingC0des/itera-agent-manifests` repo via
    `apps/api/src/domain/manifests-repo.ts` (a real `git clone`/`commit`/`push` over SSH using
    `ITERA_MANIFESTS_DEPLOY_KEY_PATH`/`_B64`, same materialization pattern as the hot signer) —
    `requesterContact` is deliberately left out of the committed file (stays in Postgres only;
    that repo is public). GitHub has no native way to restrict a deploy-key push to one file type,
    so `.md`-only is enforced in `commitMarkdownFile()` itself, before anything reaches git. A
    failed commit doesn't fail the request — reported as `manifestCommitError` in the response.
  - **On-chain issuance** (`POST /evaluations/:id/publish` triggers this): a real, non-tokenized
    Solana Attestation Service record — reuses the Credential/Schema already live on devnet from
    the pre-pivot work (`Dh9NF2L2...` / `coding-benchmark-score-v1`, PR #11), not a new Tokenized
    one, because this pivot's four pages never connect a wallet anywhere (the doc: "sem wallet
    obrigatória para a prova pública"). Anchors `scenario_id`/`fixture_hash`/`patch_hash`/
    `score_total`/`generated_at` from the real `EvidenceManifest` the grader produced. A failed
    issuance (RPC down, etc.) does not fail the publish itself — reported back as
    `attestationError` in the response instead of swallowed. Skipped entirely for a
    `timeout`/`infra_error` run (no real manifest exists to attest to).
  - CORS is restricted to `ITERA_API_CORS_ORIGINS` (comma-separated, defaults to the production web
    app and local dev). Every route except `/health` is rate-limited per client (the real client IP, or
    the wallet of a valid session; `ITERA_API_RATE_LIMIT_WINDOW_MS` / `ITERA_API_RATE_LIMIT_MAX`,
    defaults 15 min / 600 requests; public cached GETs `/public/*`, `/nft/*`, `/badge/*`, `/b/*` have
    their own bucket, `ITERA_API_PUBLIC_RATE_LIMIT_MAX`, default 3000). `ITERA_API_TRUST_PROXY`
    (default `1`) is the number of proxies in front of the API: Dokploy's Traefik only. `DATABASE_URL` points at the
    `supabase-inovatech-hackatoon` project's Postgres via a dedicated `itera_api_service` role
    (schema applied via migration, see `apps/api/src/domain/repository.pg.ts`). The Solana hot
    signer is `ITERA_HOT_SIGNER_KEYPAIR_PATH` (local file) or `ITERA_HOT_SIGNER_KEYPAIR_B64`
    (base64 content, for environments with no file on disk — see `hotSignerKeypairPath()` in
    `config.ts`). Any future secret follows `requiredSecret()` in `apps/api/src/config.ts` (env
    var from Infisical, throws if unset) — never a bare `process.env` read at the call site.
    Routes depend on the `Repository` interface (`apps/api/src/domain/repository.ts`), never on
    `pg` directly — tests inject `FakeRepository` (in-memory), production wires `PgRepository`, so
    the test suite needs no live database.
- `packages/`: shared JavaScript packages as the product grows.
- `services/`: separate services, including a possible Python evaluation service.
- `benchmarks/`: three candidate coding scenarios and the planned in-repo fixture/evaluator boundary.

Run `npm ci`, then `npm run dev` for local development. Run `npm run check`, `npm run test`, and `npm run build` before a PR. The root `Dockerfile` builds `apps/web` and serves it with `apps/web/server.mjs` (static files, SPA fallback, and OG/Twitter meta for `/e/*` link previews; `API_BASE_URL` overrides the API it reads). `apps/api/Dockerfile` builds the API. Both use the repository root as the build context.

Both Dockerfiles run `npm ci`, which checks `package-lock.json` against every workspace. When you add a workspace, add a `COPY <workspace>/package.json` line to both Dockerfiles. CI builds both images, so a missing line fails the PR.

## Open vs closed

This repository is public, with a mixed license. Details and rules: [`OPEN-SOURCE.md`](OPEN-SOURCE.md).

| Path | License | What it is | Why |
|---|---|---|---|
| `packages/contracts/` | Apache-2.0 | Task, evidence, run-profile and run-actions schemas, tool-environment helpers | Anyone who writes a task or reads a proof needs the contract |
| `apps/web/src/verify.ts` | Apache-2.0 | The browser verifier for a proof | A proof is only trustworthy if anyone can read the checker |
| `services/attestation/` | Apache-2.0 | On-chain attestation client | The proof format must be auditable |
| `mcp/catalog/` (and `mcp/base/`) | Apache-2.0 | MCP fixture servers | Task authors pin these images and need to see them |
| `docs/architecture/` | Apache-2.0 | Architecture documents | Design in public |
| `services/runner/`, `services/evaluator/`, `services/run-issuer/` | Proprietary | Agent runner, grader, proof issuer | Product logic |
| `apps/api/`, `apps/web/` (except the verifier) | Proprietary | API and web app | Product logic and UI |
| `benchmarks/` (hidden tests included), `scripts/`, `db/`, `tools/` | Proprietary | Benchmark tasks and tests, internal tooling | Hidden tests must stay out of reach of agents |

Proprietary means source available for review only: no license to use, copy, modify or distribute.
Apache-2.0 grants for published versions are irrevocable.

## API end-to-end check

`npm run e2e:api -- --base <api>` drives a deployed API with a real devnet wallet: SIWS login, `/me`,
catalog, GitHub routes, agent, quote (treasury and price itemization), one signed payment tx,
`POST /evaluations`, polling to `issued`, run detail, proof, public profile, `og.png`, badges,
leaderboard, My evaluations, and the negative checks (402, 403, 404, 401). It writes
`e2e-report/api-e2e.json` and `api-e2e.md` (`--out` changes the folder) and exits 1 when a step fails.

The wallet comes from `E2E_WALLET_SECRET_B58` (base58 secret key). It must own a GitHub App
installation that holds `--repo` (default `devfellowship/testmyagent-demo-agent`) and hold about
0.01 SOL: one run costs the quote (about US$0.18 at the recorded model cost). `--no-pay` runs the
free steps only. `--evaluation <id>` re-verifies an evaluation that is already paid. A full run uses
about 150 requests, and the API allows 300 per 15 min per IP; the script waits on a 429.

## Browser end-to-end check

`npm run e2e:browser -- --base <web>` drives the deployed web app in Chrome (Playwright) with the
demo wallet: landing, connect (SIWS), `/agents` (ranking, Task Filter modal), `/agents/new` (GitHub
connected, repo, branch, commit, path, validate), agent detail, select tasks and the itemized quote,
pay with one wallet signature, `/evaluations/:id` (states and per-call log) to `issued`, the public
profile `/e/:slug` (Verify in browser -> VERIFIED), the owner feedback prompt, My evaluations, My
tasks, the task editor Environment card, the public task page, and the agent badge. Every page step
asserts three things and takes a screenshot: the root mounts, zero `pageerror` events, and a
positive-data control. The run writes `e2e-report/browser-e2e.json` and `browser-e2e.html`
(screenshots inline) and exits 1 when a step fails.

There is no Phantom automation. The script injects a Wallet Standard test wallet into the page.
The page sees only the public key. Every signature (the SIWS message, the payment transaction) runs
in the Node process, so the secret key never enters the browser. The wallet comes from
`E2E_WALLET_SECRET_B58` (or `DEMO_WALLET_SECRET_B58`), base58, and needs a GitHub App installation
that holds `--repo` and about 0.01 SOL on devnet. One paid run on `tsk_webhook_dup` costs about
0.003 SOL. Options: `--no-pay` (free steps only), `--agent <id>` (reuse an agent instead of
registering a new one), `--task <slug>`, `--out <dir>`, `--chrome <path>`.

The step "MCP task run - pending GHCR public" stays skipped until an anonymous pull of
`ghcr.io/devfellowship/itera-mcp-helpdesk` succeeds. When it does, the step pays for and watches a
`tsk_helpdesk_refunds` run.

## CI and deployment

GitHub Actions (`.github/workflows/ci.yml`) runs on `ubuntu-latest` for every PR and every push to `main`. The repository is public, and the DFL self-hosted runner group refuses public repositories. CI runs the scenario check, `check`, `test`, `build`, and a Docker build of both images.

Deployment uses a dedicated Dokploy on `89.167.72.187`: https://itera-agent-credentials-dokploy.devfellowship.com. The credentials are in Infisical `/apps/itera-agent-credentials/`.

| Dokploy app | Dockerfile | Watch paths | URL |
|---|---|---|---|
| `itera-agent-credentials-web` | `Dockerfile` | `apps/web/**`, root package files, `Dockerfile` | https://itera-agent-credentials.devfellowship.com/ |
| `itera-agent-credentials-api` | `apps/api/Dockerfile` | `apps/api/**`, root package files | https://itera-agent-credentials-api.devfellowship.com/ |
| `itera-agent-credentials-runner` | `services/runner/Dockerfile` | `services/runner/**`, `services/evaluator/**`, `benchmarks/**`, root package files | none (worker; host Docker socket mounted, see `services/runner/README.md`) |

A GitHub repository webhook sends each push event to the deploy URL of each app. Dokploy deploys an app only when the push is on `main` and changes a file in its watch paths. CI does not gate the deployment. Both start from the same push, so check the CI result and the Dokploy deployment status. GitHub Actions holds no deployment credential.

Production URLs: https://itera-agent-credentials.devfellowship.com/ (web) and https://itera-agent-credentials-api.devfellowship.com/ (API)

Plan: https://plans.devfellowship.com/20261006-itera-certificacao-onchain-hackathon-colosseum
