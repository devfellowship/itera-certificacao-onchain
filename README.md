# Itera Agent Credentials

This repository holds the coding-agent evaluation proof of concept for the Colosseum hackathon. The current web app is a planning preview. It does not yet run evaluations or write proofs to Solana.

## Workspace

- `apps/web`: Vite, React, and TypeScript web application.
- `apps/api`: Express API in TypeScript. `GET /` returns the service status as JSON. `GET /hello-world` returns plain text. `PORT` sets the port (default `3000`).
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
