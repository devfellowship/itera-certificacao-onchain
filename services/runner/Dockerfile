# ITERA runner worker (services/runner). Build context: repository root.
# The worker is TRUSTED code: it needs the host Docker socket to start one sandbox container per run.
# The sandboxes never get the socket (see services/runner/README.md "Sandbox").
FROM node:24-alpine AS build
WORKDIR /workspace
# `npm ci` validates package-lock.json against EVERY workspace, so every
# workspace package.json must be present here. Add a line when you add a workspace.
COPY package.json package-lock.json turbo.json ./
COPY apps/web/package.json apps/web/package.json
COPY apps/api/package.json apps/api/package.json
COPY services/attestation/package.json services/attestation/package.json
COPY services/evaluator/package.json services/evaluator/package.json
COPY services/run-issuer/package.json services/run-issuer/package.json
COPY services/runner/package.json services/runner/package.json
RUN npm ci --omit=dev --workspace @itera/runner --include-workspace-root=false \
  && mkdir -p services/runner/node_modules

FROM node:24-alpine
# git: workspace baseline + diff and the evaluator. tar (GNU): docker cp streams. docker-cli: sandboxes.
RUN apk add --no-cache git tar docker-cli
WORKDIR /app
# No NODE_ENV=production: the evaluator and the workspace run `npm install` in the fixture, and
# NODE_ENV=production makes npm skip devDependencies (vitest) — every test suite then reports 0/0.
ENV ITERA_REPO_ROOT=/app
COPY --from=build /workspace/node_modules ./node_modules
COPY --from=build /workspace/services/runner/node_modules ./services/runner/node_modules
COPY services/runner/package.json services/runner/package.json
COPY services/runner/src services/runner/src
COPY services/runner/sandbox services/runner/sandbox
COPY services/evaluator/src services/evaluator/src
COPY services/evaluator/package.json services/evaluator/package.json
COPY benchmarks benchmarks
COPY apps/api/certs apps/api/certs
# Runs as root on purpose: it talks to the host Docker socket. No port, no domain.
CMD ["node", "--import", "tsx", "services/runner/src/worker.ts"]
