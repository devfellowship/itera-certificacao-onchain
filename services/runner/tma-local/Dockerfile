# ghcr.io/devfellowship/tma-local — the TestMyAgent LOCAL runner image (plan
# 20261026-tma-local-runner-and-self-declared-results, task L10, Q3 = A, Q 37d5c296 = A).
# Build context: repository root.  docker build -f services/runner/tma-local/Dockerfile .
#
# What it holds: the `tma` CLI (services/runner), the evaluator, the contracts, the curated tasks
# (benchmarks/) and the sandbox build context. Nothing else: no apps/, no db/, no scripts/, no certs,
# no .env, no key. CI checks every layer for secrets (services/runner/tma-local/leak-check.sh).
#
# Safety bar (README "The image and the launcher"):
# - base image and docker CLI pinned by digest / sha256;
# - runs as the non-root user `tma` (uid 10001). The launcher runs it as YOUR uid, with the group of
#   the Docker socket, so the files it writes in your folder are yours;
# - the HOST DOCKER SOCKET is mounted by the launcher for `tma run` and `tma grade` only. That is
#   root-equivalent on YOUR machine (Q 37d5c296 = A: acceptable on the participant's own machine).
#   The agent, gateway, grader and MCP containers never get it (src/docker-socket.guard.test.ts);
# - every sandbox container has memory, CPU and pid limits (sandbox.ts, grade.ts, mcp-sidecar.ts);
# - on Ctrl-C / docker stop, the CLI removes the containers of its own runs (src/cli/cleanup.ts).

# node:24-bookworm-slim, multi-arch index digest read 2026-10-28.
FROM node:24-bookworm-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c AS base

FROM base AS dockercli
# Static docker CLI 27.5.1 (x86_64), checked against its sha256 (read 2026-10-28 from download.docker.com).
# (sha256sum, not `ADD --checksum`: that flag needs BuildKit, and the legacy builder must work too.)
ADD https://download.docker.com/linux/static/stable/x86_64/docker-27.5.1.tgz /tmp/docker.tgz
RUN echo "4f798b3ee1e0140eab5bf30b0edc4e84f4cdb53255a429dc3bbae9524845d640  /tmp/docker.tgz" | sha256sum -c - \
  && tar -xzf /tmp/docker.tgz -C /tmp docker/docker

FROM base AS build
WORKDIR /workspace
# `npm ci` validates package-lock.json against EVERY workspace, so every workspace package.json is here.
COPY package.json package-lock.json turbo.json ./
COPY apps/web/package.json apps/web/package.json
COPY apps/web2/package.json apps/web2/package.json
COPY apps/api/package.json apps/api/package.json
COPY services/attestation/package.json services/attestation/package.json
COPY services/evaluator/package.json services/evaluator/package.json
COPY services/run-issuer/package.json services/run-issuer/package.json
COPY services/runner/package.json services/runner/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN npm ci --omit=dev --ignore-scripts --workspace @itera/runner --include-workspace-root=false \
  && mkdir -p services/runner/node_modules

# The app files, in a stage of their own: the runner/evaluator/contracts unit tests (fake key shapes in
# their fixtures) are removed
# HERE, so they are in no layer of the final image, not only hidden by a later layer.
FROM base AS app
WORKDIR /app
COPY services/runner/package.json services/runner/package.json
COPY services/runner/src services/runner/src
COPY services/runner/sandbox services/runner/sandbox
COPY services/runner/profiles services/runner/profiles
COPY services/evaluator/src services/evaluator/src
COPY services/evaluator/package.json services/evaluator/package.json
COPY packages/contracts packages/contracts
COPY benchmarks benchmarks
COPY LICENSE OPEN-SOURCE.md ./
COPY services/runner/tma-local/LICENSE-USE.md LICENSE-USE.md
# Only the product code: the task tests under benchmarks/ ARE the grader and must stay.
RUN find /app/services /app/packages \( -name '*.test.ts' -o -name '*.test.mjs' -o -name '*.test.js' -o -name 'vitest.config.*' \) -delete \
  && rm -rf /app/services/runner/src/cli/test \
  && chmod -R a+rX /app

FROM base
ARG TMA_VERSION=0.0.0-dev
LABEL org.opencontainers.image.title="tma-local" \
      org.opencontainers.image.description="TestMyAgent local runner: run and grade an agent on your own machine, upload numbers only." \
      org.opencontainers.image.source="https://github.com/devfellowship/itera-certificacao-onchain" \
      org.opencontainers.image.licenses="LicenseRef-TMA-Local-Use" \
      org.opencontainers.image.version="${TMA_VERSION}"
# git: workspace baseline + diff. tar (GNU): docker cp streams. docker CLI: the sandboxes.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  # The launcher runs the image as YOUR uid on YOUR folder: git must accept that folder.
  && git config --system safe.directory '*' \
  && groupadd --gid 10001 tma && useradd --uid 10001 --gid 10001 --home-dir /home/tma --create-home --shell /usr/sbin/nologin tma
COPY --from=dockercli /tmp/docker/docker /usr/local/bin/docker
WORKDIR /app
COPY --from=build /workspace/node_modules ./node_modules
COPY --from=build /workspace/services/runner/node_modules ./services/runner/node_modules
# Any uid can read the app (chmod in the app stage); only /tmp and the user's own folders are written.
COPY --from=app /app /app
ENV HOME=/home/tma TMA_CONFIG_DIR=/home/tma/.config/tma
USER 10001:10001
# Absolute loader path: the launcher sets the working directory to YOUR folder, where `--import tsx` would not resolve.
ENTRYPOINT ["node", "--import", "/app/node_modules/tsx/dist/loader.mjs", "/app/services/runner/src/cli/tma.ts"]
CMD ["--help"]
