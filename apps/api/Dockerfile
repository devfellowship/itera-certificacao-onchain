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
COPY services/runner/package.json services/runner/package.json
RUN npm ci
COPY apps/api apps/api
# domain/grader.ts spawns services/evaluator's CLI as a separate process (this repo's convention —
# never cross-imported), and that CLI shells out to `npm install`/`vitest` inside a fresh copy of
# benchmarks/<scenario>/fixture at grading time — so both services/evaluator's full source AND
# benchmarks/ need to ship in the image, not just apps/api. Previously missing entirely (README
# called this "Not built yet, explicitly out of scope"); added once a real end-to-end test
# actually needed it (Tainan Fidelis, Discord #web3, 2026-10-12).
COPY services/evaluator services/evaluator
COPY benchmarks benchmarks
RUN npx turbo run build --filter=@itera/api \
  && npm prune --omit=dev

FROM node:24-alpine
ENV NODE_ENV=production PORT=3000
# domain/manifests-repo.ts spawns `git` (and `GIT_SSH_COMMAND` needs `ssh`) to commit into the
# public manifests repo, and services/evaluator/src/runner.ts spawns `git` too (diffing the
# fixture before/after the patch) — node:24-alpine has neither by default, so every route calling
# commitMarkdownFile() AND every real grading run failed in production with "spawn git ENOENT"
# until this line (Tainan Fidelis, Discord #web3, 2026-10-12, first real PreparePage test).
RUN apk add --no-cache git openssh-client
WORKDIR /app
# grader.ts spawns `npx tsx services/evaluator/src/cli.ts` with this as cwd — see
# apps/api/src/domain/paths.ts for why REPO_ROOT can't be derived from this file's own location
# alone in this flattened image layout.
ENV ITERA_REPO_ROOT=/app
COPY --from=build /workspace/node_modules ./node_modules
COPY --from=build /workspace/apps/api/package.json ./package.json
COPY --from=build /workspace/apps/api/dist ./dist
COPY --from=build /workspace/apps/api/certs ./certs
COPY --from=build /workspace/services/evaluator ./services/evaluator
COPY --from=build /workspace/benchmarks ./benchmarks
# Fonts for the NFT image (chain/nft-image.ts) — alpine ships no system fonts.
COPY --from=build /workspace/apps/api/assets ./assets
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s CMD wget -q -O /dev/null http://127.0.0.1:${PORT}/health || exit 1
CMD ["node", "dist/server.js"]
