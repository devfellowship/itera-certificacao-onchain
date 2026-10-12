# Web app (apps/web), served by apps/web/server.mjs (static files + OG meta for /e/*, U14).
# Build context: repository root.
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
COPY packages/contracts/package.json packages/contracts/package.json
RUN npm ci
COPY apps/web apps/web
RUN npx turbo run build --filter=@itera/web

FROM node:24-alpine
ENV NODE_ENV=production PORT=80
WORKDIR /app
# No npm install: server.mjs uses node:http only.
COPY apps/web/server.mjs ./server.mjs
COPY --from=build /workspace/apps/web/dist ./dist
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s CMD wget -q -O /dev/null http://127.0.0.1/health || exit 1
CMD ["node", "server.mjs"]
