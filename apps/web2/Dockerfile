# Web2 client (apps/web2), served by apps/web2/server.mjs (static files + SPA fallback + /health + /version).
# Build context: repository root.
# Deployed commit for GET /version (task L16). Dokploy clones the repo, so `.git` is in the build context.
# A bind mount (not COPY) keeps this stage working, with the commit "unknown", when `.git` is absent
# (a tarball build). `--build-arg GIT_COMMIT=<sha>` wins when given. Only this stage reruns per commit.
FROM node:24-alpine AS gitsha
RUN apk add --no-cache git
ARG GIT_COMMIT=
RUN --mount=type=bind,source=.,target=/ctx \
    c="$GIT_COMMIT"; \
    [ -n "$c" ] || c="$(git -c safe.directory='*' -C /ctx rev-parse HEAD 2>/dev/null || true)"; \
    case "$c" in *[!0-9a-f]*|"") c=unknown ;; esac; \
    [ "${#c}" = 40 ] || c=unknown; \
    printf '%s' "$c" > /GIT_COMMIT

FROM node:24-alpine AS build
WORKDIR /workspace
# `npm ci` validates package-lock.json against EVERY workspace, so every
# workspace package.json must be present here. Add a line when you add a workspace.
COPY package.json package-lock.json turbo.json ./
COPY apps/web/package.json apps/web/package.json
COPY apps/web2/package.json apps/web2/package.json
COPY apps/api/package.json apps/api/package.json
COPY services/attestation/package.json services/attestation/package.json
COPY services/evaluator/package.json services/evaluator/package.json
COPY services/run-issuer/package.json services/run-issuer/package.json
COPY services/runner/package.json services/runner/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN npm ci
COPY apps/web2 apps/web2
COPY packages/contracts packages/contracts
# VITE_* values are read at build time. Pass --build-arg to change them.
ARG VITE_TMA_API_URL
ARG VITE_DFL_FEDERATE_URL
RUN npx turbo run build --filter=@itera/web2

FROM node:24-alpine
ENV NODE_ENV=production PORT=80
WORKDIR /app
# No npm install: server.mjs uses node:http only.
COPY apps/web2/server.mjs ./server.mjs
COPY --from=build /workspace/apps/web2/dist ./dist
# GET /version reads this file (or the GIT_COMMIT env var).
COPY --from=gitsha /GIT_COMMIT ./GIT_COMMIT
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s CMD wget -q -O /dev/null http://127.0.0.1/health || exit 1
CMD ["node", "server.mjs"]
