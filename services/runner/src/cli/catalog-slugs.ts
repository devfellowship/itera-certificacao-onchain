// The static catalog of TestMyAgent tasks, as the CLI knows it (plan TMA, Q 5eff17c7: the bundle folder
// name IS the catalog slug). The CLI never calls the API for this list and never reads the environment.
//
// - CATALOG_SLUGS: the slugs of the live catalog (table `tasks`, GET /tasks). A result that names one of
//   them goes up as `task.catalog`.
// - CATALOG_BUNDLES: the folders under benchmarks/ that claim a catalog task. The folder name is the slug.
// - PRIVATE_BUNDLES: the folders under benchmarks/ that are NOT in the catalog. `--task <folder>` on one
//   of them produces a private reference (`task.local`), as `--task-dir` does; the API would answer 404
//   on a catalog reference.
// bundles.guard.test.ts checks that every folder under benchmarks/ is in exactly one list, that every
// listed name has a folder, and that every catalog bundle is a catalog slug.

export const CATALOG_SLUGS = [
  'tsk_webhook_dup',
  'tsk_helpdesk_refunds',
  'tsk_flaky_state',
  'tsk_gh_ci_fix',
  'tsk_gh_release',
  'tsk_idem_keys',
  'tsk_op_export',
  'tsk_op_tokens',
  'tsk_pg_index',
  'tsk_refund_race',
] as const;

export const CATALOG_BUNDLES = ['tsk_webhook_dup', 'tsk_helpdesk_refunds'] as const;

export const PRIVATE_BUNDLES = [
  'dfl-fleet-research',
  'dfl-html-report',
  'dfl-session-decision-trajectory-extraction',
  'dfl-transcript-mining',
  'dfl-ui-design-audit',
  'loop-acquisition-search-terms',
] as const;

export const isCatalogSlug = (s: string): boolean => (CATALOG_SLUGS as readonly string[]).includes(s);
export const isCatalogBundle = (folder: string): boolean => (CATALOG_BUNDLES as readonly string[]).includes(folder);
