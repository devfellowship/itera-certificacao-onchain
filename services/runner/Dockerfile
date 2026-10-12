# ITERA runner worker (services/runner). Build context: repository root.
# The worker is TRUSTED code: it needs the host Docker socket to start one sandbox container per run.
# The sandboxes never get the socket (see services/runner/README.md "Sandbox").
# Debian (glibc), NOT alpine: the worker installs the fixture's node_modules that the agent sandbox and
# the grader container (both Debian, services/runner/sandbox/Dockerfile) then execute. Native packages
# (rollup, esbuild) installed on musl do not load on glibc: on alpine, every vitest call in the sandbox
# failed (measured on the production host, 2026-10-12).
FROM node:24-bookworm-slim AS dockercli
ADD https://download.docker.com/linux/static/stable/x86_64/docker-27.5.1.tgz /tmp/docker.tgz
RUN tar -xzf /tmp/docker.tgz -C /tmp docker/docker

FROM node:24-bookworm-slim AS build
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

FROM node:24-bookworm-slim
# git: workspace baseline + diff. tar (GNU): docker cp streams. docker CLI: sandboxes.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=dockercli /tmp/docker/docker /usr/local/bin/docker
WORKDIR /app
# No NODE_ENV=production: the worker runs `npm ci` in the fixture (agent workspace and grader), and
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
