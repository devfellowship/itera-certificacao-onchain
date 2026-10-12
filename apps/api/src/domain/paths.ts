import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// In dev (tsx running apps/api/src/domain/paths.ts) and in CI/tests, this file sits 4 levels
// below the repo root (domain -> src -> api -> apps), so walking up 4 reaches it correctly.
//
// The production Docker image does NOT mirror that layout: apps/api/Dockerfile's final stage
// sets WORKDIR /app to what amounts to apps/api/ (not the repo root) and copies only dist/ into
// it, so the equivalent file there is /app/dist/domain/paths.js — just 2 levels under /app, which
// is itself one level short of the real repo root. Walking up 4 from there overflows past the
// filesystem root entirely (resolved to "/" in production, confirmed via the real
// "Cannot find module '/services/evaluator/src/cli.ts'" error this caused — Tainan Fidelis,
// Discord #web3, 2026-10-12, first real PreparePage test). ITERA_REPO_ROOT (set in the
// Dockerfile, where services/evaluator and benchmarks/ are vendored into the image) is the fix:
// an explicit override takes priority over the relative walk, which stays correct for dev/tests.
const here = dirname(fileURLToPath(import.meta.url));

export const REPO_ROOT = process.env.ITERA_REPO_ROOT ?? resolve(here, '..', '..', '..', '..');
