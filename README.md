# Itera Agent Credentials

This repository holds the coding-agent evaluation proof of concept for the Colosseum hackathon. The current web app is a planning preview. It does not yet run evaluations or write proofs to Solana.

## Workspace

- `apps/web`: Vite, React, and TypeScript web application.
- `apps/api`: Express API in TypeScript, backing the testmyagent.com entity model (vendor proves
  one task to one buyer — see `03_produto_mvp_72h.pdf` from the 2026-10-11 pivot doc, the reference
  for every route/field name below). `PORT` sets the port (default `3000`).
  - `GET /`: service status as JSON. `GET /health`: minimal liveness check, used by the Dockerfile
    `HEALTHCHECK`, not rate-limited or CORS-gated. `GET /hello-world`: plain text.
  - **Vendor-side, requires the `x-operator-key` header** (`ITERA_API_OPERATOR_KEY` — a shared
    secret, not a full auth system; see `apps/api/src/config.ts` `operatorApiKey()` for why):
    `POST /evaluations` (idempotent on `idempotencyKey` in the body; creates a `pending` run for a
    known task pack — only `webhook-ledger`/`1` is seeded), `GET /evaluations/:id/events`
    (observed request/response trail), `POST /evaluations/:id/publish` (redacts and appends a new
    `claim_manifests` row; 409 if the run is still `pending` — publishing an unresolved run would
    mean asserting a result nothing graded).
  - **Buyer-side, public and read-only**: `GET /credentials/:id`, `GET /credentials/:id/verify`
    (recomputes the manifest digest for real; the on-chain checks report `unavailable` until
    attestation issuance is wired in — never faked as passing), `GET /credentials/:id/export`.
  - **Public intake**: `POST /evaluation-requests` ("Solicitar teste na minha tarefa" — contact +
    free-text description only, no code/secret fields).
  - CORS is restricted to `ITERA_API_CORS_ORIGINS` (comma-separated, defaults to the production web
    app and local dev). Every route is rate-limited (`ITERA_API_RATE_LIMIT_WINDOW_MS` /
    `ITERA_API_RATE_LIMIT_MAX`, defaults 15 min / 300 requests). `DATABASE_URL` points at the
    `supabase-inovatech-hackatoon` project's Postgres (schema applied via migration, see
    `apps/api/src/domain/repository.pg.ts`). Any future secret follows `requiredSecret()` in
    `apps/api/src/config.ts` (env var from Infisical, throws if unset) — never a bare
    `process.env` read at the call site. Routes depend on the `Repository` interface
    (`apps/api/src/domain/repository.ts`), never on `pg` directly — tests inject
    `FakeRepository` (in-memory), production wires `PgRepository`, so the test suite needs no
    live database.
  - **Not built yet, explicitly out of scope for this slice**: dispatching the challenge to the
    vendor's allowlisted endpoint and running the grader (so a run never leaves `pending` on its
    own right now), and wiring Solana attestation issuance/verification into this API (the
    `/verify` on-chain checks stay `unavailable`). Both are real gaps, not hidden ones.
- `packages/`: shared JavaScript packages as the product grows.
- `services/`: separate services, including a possible Python evaluation service.
- `benchmarks/`: three candidate coding scenarios and the planned in-repo fixture/evaluator boundary.

Run `npm ci`, then `npm run dev` for local development. Run `npm run check`, `npm run test`, and `npm run build` before a PR. The root `Dockerfile` builds `apps/web` and serves it through Nginx. `apps/api/Dockerfile` builds the API. Both use the repository root as the build context.

Both Dockerfiles run `npm ci`, which checks `package-lock.json` against every workspace. When you add a workspace, add a `COPY <workspace>/package.json` line to both Dockerfiles. CI builds both images, so a missing line fails the PR.

## CI and deployment

GitHub Actions (`.github/workflows/ci.yml`) runs on `ubuntu-latest` for every PR and every push to `main`. The repository is public, and the DFL self-hosted runner group refuses public repositories. CI runs the scenario check, `check`, `test`, `build`, and a Docker build of both images.

Deployment uses a dedicated Dokploy on `89.167.72.187`: https://itera-agent-credentials-dokploy.devfellowship.com. The credentials are in Infisical `/apps/itera-agent-credentials/`.

| Dokploy app | Dockerfile | Watch paths | URL |
|---|---|---|---|
| `itera-agent-credentials-web` | `Dockerfile` | `apps/web/**`, root package files, `Dockerfile` | https://itera-agent-credentials.devfellowship.com/ |
| `itera-agent-credentials-api` | `apps/api/Dockerfile` | `apps/api/**`, root package files | https://itera-agent-credentials-api.devfellowship.com/ |

A GitHub repository webhook sends each push event to the deploy URL of each app. Dokploy deploys an app only when the push is on `main` and changes a file in its watch paths. CI does not gate the deployment. Both start from the same push, so check the CI result and the Dokploy deployment status. GitHub Actions holds no deployment credential.

Production URLs: https://itera-agent-credentials.devfellowship.com/ (web) and https://itera-agent-credentials-api.devfellowship.com/ (API)

Plan: https://plans.devfellowship.com/20261006-itera-certificacao-onchain-hackathon-colosseum
