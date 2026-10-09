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
RUN npm ci
COPY apps/api apps/api
RUN npx turbo run build --filter=@itera/api \
  && npm prune --omit=dev

FROM node:24-alpine
ENV NODE_ENV=production PORT=3000
WORKDIR /app
COPY --from=build /workspace/node_modules ./node_modules
COPY --from=build /workspace/apps/api/package.json ./package.json
COPY --from=build /workspace/apps/api/dist ./dist
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s CMD wget -q -O /dev/null http://127.0.0.1:${PORT}/ || exit 1
CMD ["node", "dist/server.js"]
