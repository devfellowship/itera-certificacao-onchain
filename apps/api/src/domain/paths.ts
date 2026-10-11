import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// This file lives at apps/api/src/domain/paths.ts -> domain -> src -> api -> apps -> repo root
// (4 levels up). Same depth whether running from src/ via tsx (dev) or dist/ via node (build
// mirrors src/ 1:1, see tsconfig.build.json).
const here = dirname(fileURLToPath(import.meta.url));

export const REPO_ROOT = resolve(here, '..', '..', '..', '..');
