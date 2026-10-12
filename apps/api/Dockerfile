# Express API (apps/api). Build context: repository root.
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
RUN npm ci
COPY apps/api apps/api
RUN npx turbo run build --filter=@itera/api \
  && npm prune --omit=dev

FROM node:24-alpine
ENV NODE_ENV=production PORT=3000
# domain/manifests-repo.ts spawns `git` (and `GIT_SSH_COMMAND` needs `ssh`) to commit into the
# public manifests repo — node:24-alpine has neither by default, so every route that calls
# commitMarkdownFile() (POST /evaluation-requests, POST /agent-endpoint-manifests) failed in
# production with "spawn git ENOENT" until this line (Tainan Fidelis, Discord #web3, 2026-10-12,
# first real PreparePage test).
RUN apk add --no-cache git openssh-client
WORKDIR /app
COPY --from=build /workspace/node_modules ./node_modules
COPY --from=build /workspace/apps/api/package.json ./package.json
COPY --from=build /workspace/apps/api/dist ./dist
COPY --from=build /workspace/apps/api/certs ./certs
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s CMD wget -q -O /dev/null http://127.0.0.1:${PORT}/health || exit 1
CMD ["node", "dist/server.js"]
