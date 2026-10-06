# Itera Agent Credentials

This repository holds the coding-agent evaluation proof of concept for the Colosseum hackathon. The current web app is a planning preview. It does not yet run evaluations or write proofs to Solana.

## Workspace

- `apps/web`: Vite, React, and TypeScript web application.
- `packages/`: shared JavaScript packages as the product grows.
- `services/`: separate services, including a possible Python evaluation service.

Run `npm ci`, then `npm run dev` for local development. Run `npm run check` and `npm run build` before a PR. The root Dockerfile builds `apps/web` and serves it through Nginx.

## CI and deployment

GitHub Actions runs checks and a Docker build on PRs and on pushes to `main`. It uses the DFL self-hosted runner. Dokploy separately receives the GitHub App's push webhook for `main`; `autoDeploy=true` makes Dokploy clone, rebuild, and replace the app on that push. The CI workflow does not gate the Dokploy deployment. Both systems start from the same push, so maintainers must inspect the CI result and the Dokploy deployment status. No deployment credential is stored in GitHub Actions.

Production URL: https://itera-agent-credentials.devfellowship.com/

Plan: https://plans.devfellowship.com/20261006-itera-certificacao-onchain-hackathon-colosseum
