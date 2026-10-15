# Web2 client (apps/web2), served by apps/web2/server.mjs (static files + SPA fallback + /health).
# Build context: repository root.
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
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s CMD wget -q -O /dev/null http://127.0.0.1/health || exit 1
CMD ["node", "server.mjs"]
