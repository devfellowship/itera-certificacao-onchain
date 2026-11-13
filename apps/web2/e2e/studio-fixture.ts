/**
 * The persistent studio smoke fixture (C5-T3/T4/T5 acceptance, plan 20261112-tma-c5-studio-area-web2).
 *
 * WHY IT STAYS IN PRODUCTION: a prod render check needs a "fixture known to hold data" (CLAUDE.md, "Verified in
 * prod" assertion 3). The studio screens show only the caller's own uploads, so the DFL smoke user owns ONE test
 * case, `studio-smoke-fixture`, with two agent variants (baseline + skill, 5 runs each) and one grader version.
 * The spec never deletes it. The ensure step is idempotent: when the case already holds both variants it uploads
 * nothing; otherwise it sends the same deterministic bodies again (the API answers `unchanged` for rows it has).
 *
 * Every value is synthetic: digests are sha256 of fixed labels, numbers are invented. Nothing here is a secret.
 * The session bearer is read INSIDE the browser (localStorage) and used there; it never reaches Node, a log or a file.
 */
import { createHash } from 'node:crypto'
import type { Page } from '@playwright/test'

export const FIXTURE_CASE_KEY = 'studio-smoke-fixture'
export const FIXTURE_USE_CASE = 'verify/prod-verify'
export const FIXTURE_GRADER_ID = 'studio-smoke-fixture-grader'
export const FIXTURE_GRADER_SEMVER = '1.0.0'
export const FIXTURE_AGENT_NAME = 'studio smoke fixture agent'
/** A route-prefixed id of the model catalog (routes.json `opencode-go`): known to the API without a catalog sync. */
export const FIXTURE_MODEL = 'opencode-go/deepseek-v4-pro'
export const FIXTURE_TASK_SLUG = 'studio-smoke-fixture-task'
export const FIXTURE_SKILL_LABEL = 'skill: verify checklist'
export const FIXTURE_BASELINE_LABEL = 'baseline'
export const REPEATS = 5

/** localStorage key of the web2 session (apps/web2/src/auth/sessionStorage.ts SESSION_KEY). */
const SESSION_KEY = 'tma2.session'
/** sha256 of the empty diff (EMPTY_DIFF_SHA256 of @itera/contracts): the variant digest of a baseline. */
const EMPTY_DIFF_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

const sha = (label: string) => createHash('sha256').update(`studio-smoke-fixture:${label}`).digest('hex')

export const TASK_SUMMARY = {
  before: 'The deploy finished, but nobody checked that prod serves the new commit and that the page mounts with data.',
  expected: 'The agent proves the deployed commit, then asserts mount, zero page errors and one row of known data.',
}

type Step = Record<string, unknown>

function step(seq: number, tool: string, stepKind: string, family: string, targetKind: string, target: string | null): Step {
  return {
    seq,
    parent_seq: null,
    turn: seq,
    tool,
    tool_family: family,
    status: 'ok',
    error_class: null,
    duration_ms: 400 + seq * 100,
    tokens_in: 800 + seq * 10,
    tokens_out: 60 + seq,
    target_kind: targetKind,
    target_redacted: target,
    args_sha256: sha(`args:${seq}:${tool}`),
    result_sha256: sha(`result:${seq}:${tool}`),
    retry_of: null,
    step_kind: stepKind,
    started_ms: seq * 1500,
    turn_origin: seq === 1 ? 'human' : 'agent',
  }
}

/** A short tma-trajectory/2 step list: read, search, write, test (the skill variant adds a second test). */
function trajectory(skill: boolean) {
  const steps = [
    step(1, 'Read', 'read', 'builtin', 'file', 'src/verify/prod-check.ts'),
    step(2, 'Grep', 'search', 'builtin', 'pattern', 'expectMounted'),
    step(3, 'Edit', 'write', 'builtin', 'file', 'src/verify/prod-check.ts'),
    step(4, 'Bash', 'test', 'shell', 'command', 'npm test <args>'),
  ]
  if (skill) steps.push(step(5, 'Bash', 'test', 'shell', 'command', 'npx playwright test <args>'))
  return { format: 'tma-trajectory/2', steps }
}

/** Baseline about 60-80 (fail), skill variant 90-100 (pass): case-compare gives "better" on 5 vs 5. */
const BASELINE_SCORES = [62, 68, 71, 75, 79]
const SKILL_SCORES = [91, 94, 96, 98, 100]

function grader(score: number, pass: boolean) {
  return {
    id: FIXTURE_GRADER_ID,
    semver: FIXTURE_GRADER_SEMVER,
    code_sha256: sha('grader-code'),
    kind: 'code',
    pass,
    score,
    weight: 1,
    // Not a hard gate: a failed hard gate scores 0 in case-compare, and the fixture wants the real scores.
    hard_gate: false,
    decisive: true,
    proof: { caught: 3, total: 3 },
    note: 'studio smoke fixture grader',
    author: 'studio-e2e',
  }
}

function run(repeat: number, score: number) {
  const pass = score >= 90
  return {
    item_sha256: sha('item'),
    repeat,
    status: pass ? 'pass' : 'fail',
    score,
    wall_s: 120 + repeat * 7,
    cost_usd: null,
    tokens_in: 9000 + repeat * 100,
    tokens_out: 700 + repeat * 10,
    error_class: null,
    parts: null,
    infra_ok: true,
    graders: [grader(score, pass)],
    trajectory: trajectory(score >= 90),
  }
}

/** One tma-local-result/3 body: one variant of the fixture case, 5 runs. Deterministic (same input, same body). */
export function fixtureBody(agentId: string, which: 'baseline' | 'skill'): Record<string, unknown> {
  const isBaseline = which === 'baseline'
  const scores = isBaseline ? BASELINE_SCORES : SKILL_SCORES
  const runs = scores.map((s, i) => run(i + 1, s))
  const mean = Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10
  return {
    format: 'tma-local-result/3',
    agent_id: agentId,
    task: {
      local: {
        slug: FIXTURE_TASK_SLUG,
        name: 'Studio smoke fixture task',
        description: 'Synthetic task of the studio e2e fixture. No real run.',
        contract_sha256: sha('task-contract'),
        environment_sha256: sha('task-environment'),
        hidden_tests_sha256: sha('task-hidden-tests'),
      },
    },
    metrics_shape: 'tma-score/1',
    grader_version: '1.1.0',
    runner: { version: '0.1.0', execution: 'external', profile: null, sandbox_image_id: null },
    executor: { model_id: FIXTURE_MODEL, provider: 'deepseek', route: 'opencode-go', harness: 'opencode 1.18.31', variant: null, cost_source: 'none' },
    ran_from: '2026-11-13T10:00:00Z',
    ran_to: '2026-11-13T10:30:00Z',
    summary: { score: mean, runs: runs.length, items: 1, pass_rate: runs.filter((r) => r.status === 'pass').length / runs.length },
    runs,
    case: {
      case_key: FIXTURE_CASE_KEY,
      manifest_sha256: sha('case-manifest'),
      origin_pin_sha256: sha('origin-pin'),
      mode: 'replay',
      use_case_key: FIXTURE_USE_CASE,
      task_summary: TASK_SUMMARY,
    },
    variant: {
      agent: {
        harness: 'opencode',
        harness_version: '1.18.31',
        harness_repo_sha: null,
        model_id: FIXTURE_MODEL,
        rules_sha256: sha('rules'),
        skills_sha256: sha('skills'),
        mcp_manifest_sha256: null,
        tools_sha256: null,
      },
      variant_sha256: isBaseline ? EMPTY_DIFF_SHA256 : sha('variant-skill'),
      label: isBaseline ? FIXTURE_BASELINE_LABEL : FIXTURE_SKILL_LABEL,
      change_kind: isBaseline ? 'none' : 'skill',
    },
    comparison: { is_baseline: isBaseline, prediction_sha256: isBaseline ? null : sha('prediction-skill') },
  }
}

export type ApiAnswer = { status: number; text: string }

/**
 * Call the TMA API from the page context with the session bearer of localStorage.
 * The token is read and used inside the browser only. Status 0 = no session or a network error (text says which).
 */
export async function apiCall(page: Page, apiBase: string, method: 'GET' | 'POST', path: string, body?: unknown): Promise<ApiAnswer> {
  return page.evaluate(
    async ({ apiBase, method, path, body, key }) => {
      let token: string | null = null
      try {
        const raw = localStorage.getItem(key)
        token = raw ? (JSON.parse(raw) as { token?: string }).token ?? null : null
      } catch {
        token = null
      }
      if (!token) return { status: 0, text: `no web2 session in localStorage (${key})` }
      const headers: Record<string, string> = { Authorization: `Bearer ${token}` }
      if (body !== undefined) headers['Content-Type'] = 'application/json'
      try {
        const res = await fetch(`${apiBase}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
        return { status: res.status, text: await res.text() }
      } catch (e) {
        return { status: 0, text: `network error: ${e instanceof Error ? e.message : String(e)}` }
      }
    },
    { apiBase, method, path, body, key: SESSION_KEY },
  )
}

/** Parse a JSON answer of an expected status; else throw with the status and the (short) error body. */
export function jsonOf<T>(a: ApiAnswer, what: string, ok: number[] = [200]): T {
  if (!ok.includes(a.status)) throw new Error(`${what}: HTTP ${a.status} ${a.text.slice(0, 500)}`)
  try {
    return JSON.parse(a.text) as T
  } catch {
    throw new Error(`${what}: HTTP ${a.status}, the body is not JSON: ${a.text.slice(0, 200)}`)
  }
}

type CaseListItem = { id: string; caseKey: string; useCaseKey: string }
type CaseVariant = { id: string; label: string; changeKind: string; isBaseline: boolean; n: number }
type CaseDetail = { id: string; caseKey: string; graders: Array<{ id: string; semver: string }>; variants: CaseVariant[] }

export interface Fixture {
  caseId: string
  baselineVariantId: string
  skillVariantId: string
  /** True when this call uploaded (the fixture did not exist complete before). */
  uploaded: boolean
}

async function findCase(page: Page, apiBase: string): Promise<CaseListItem | null> {
  const list = jsonOf<{ cases: CaseListItem[] }>(await apiCall(page, apiBase, 'GET', '/eval-cases'), 'GET /eval-cases')
  return list.cases.find((c) => c.caseKey === FIXTURE_CASE_KEY) ?? null
}

async function caseDetail(page: Page, apiBase: string, id: string): Promise<CaseDetail> {
  return jsonOf<CaseDetail>(await apiCall(page, apiBase, 'GET', `/eval-cases/${encodeURIComponent(id)}`), `GET /eval-cases/${id}`)
}

function complete(d: CaseDetail): { baseline: CaseVariant; skill: CaseVariant } | null {
  const baseline = d.variants.find((v) => v.isBaseline && v.n >= REPEATS)
  const skill = d.variants.find((v) => !v.isBaseline && v.changeKind === 'skill' && v.n >= REPEATS)
  const grader = d.graders.some((g) => g.id === FIXTURE_GRADER_ID && g.semver === FIXTURE_GRADER_SEMVER)
  return baseline && skill && grader ? { baseline, skill } : null
}

/** The smoke user's local agent of the fixture: found by name, else created (POST /agents/local). */
async function fixtureAgentId(page: Page, apiBase: string): Promise<string> {
  const find = async () => {
    const r = jsonOf<{ agents: Array<{ id: string; name: string; connector?: string }> }>(
      await apiCall(page, apiBase, 'GET', '/agents?include=local'),
      'GET /agents?include=local',
    )
    return r.agents.find((a) => a.name === FIXTURE_AGENT_NAME && a.connector === 'local')?.id ?? null
  }
  const found = await find()
  if (found) return found
  const created = await apiCall(page, apiBase, 'POST', '/agents/local', {
    name: FIXTURE_AGENT_NAME,
    model_id: FIXTURE_MODEL,
    route_key: 'opencode-go',
    provider_key: 'deepseek',
    harness: 'opencode',
    description: 'Owner of the studio e2e smoke fixture.',
  })
  if (created.status === 409) {
    const again = await find()
    if (again) return again
  }
  return jsonOf<{ agent: { id: string } }>(created, 'POST /agents/local', [201]).agent.id
}

/**
 * Ensure the fixture exists and return its ids. No upload when the case already holds both variants with
 * 5 runs each and the grader version. An upload error fails with its status and error body (never the token).
 */
export async function ensureStudioFixture(page: Page, apiBase: string): Promise<Fixture> {
  const existing = await findCase(page, apiBase)
  if (existing) {
    const ok = complete(await caseDetail(page, apiBase, existing.id))
    if (ok) return { caseId: existing.id, baselineVariantId: ok.baseline.id, skillVariantId: ok.skill.id, uploaded: false }
  }
  const agentId = await fixtureAgentId(page, apiBase)
  // The baseline first: the first baseline of a case wins (409 baseline_exists for another one).
  for (const which of ['baseline', 'skill'] as const) {
    const a = await apiCall(page, apiBase, 'POST', '/self-declared-results', fixtureBody(agentId, which))
    jsonOf(a, `POST /self-declared-results (${which})`, [200, 201])
  }
  const kase = await findCase(page, apiBase)
  if (!kase) throw new Error(`the upload succeeded, but GET /eval-cases has no case ${FIXTURE_CASE_KEY}`)
  const detail = await caseDetail(page, apiBase, kase.id)
  const ok = complete(detail)
  if (!ok) {
    const seen = detail.variants.map((v) => `${v.label}/${v.changeKind}/n=${v.n}`).join(', ')
    throw new Error(`fixture case ${kase.id} is not complete after the upload: variants [${seen}], graders ${detail.graders.length}`)
  }
  return { caseId: kase.id, baselineVariantId: ok.baseline.id, skillVariantId: ok.skill.id, uploaded: true }
}
