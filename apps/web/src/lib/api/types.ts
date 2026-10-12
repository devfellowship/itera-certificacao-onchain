/**
 * Types of the API contract in plan 20261012-itera-testmyagent-ui-refactor, section "API contract".
 * Marks: [EXISTING] lives on the API today; [NEW]/[EXT] arrive with lanes U5, U7, U8, U14, U15, U19, U21.
 * Money: lamports as integers plus a `sol` string. Times: ISO-8601 strings.
 * When a lane changes a shape on the API, it changes it here in the same PR.
 */

// ---------- Identity ----------
export interface NonceResponse {
  nonce: string
  message: string
  expiresAt: string
}
export interface VerifyResponse {
  token: string
  wallet: string
  expiresAt: string
}
export interface AuthMe {
  wallet: string
}
export interface Me {
  wallet: string
  displayName: string | null
  handle: string | null
  initials: string
}
export interface PatchMeInput {
  displayName?: string
  handle?: string
}

// ---------- Catalog ----------
export type TagKind = 'tool' | 'concept'
export interface Tag {
  id: string
  name: string
  kind: TagKind
  count?: number
}
export type TaskSource = 'all' | 'public' | 'mine'
export type TaskKind = 'itera' | 'user'
export type TaskVisibility = 'public' | 'private' | 'draft'
export type TaskStatus = 'draft' | 'validating' | 'ready' | 'invalid'
export interface Task {
  id: string
  slug: string
  name: string
  description: string
  tags: Tag[]
  kind: TaskKind
  visibility: TaskVisibility
  status: TaskStatus
  runnable: boolean
  hiddenTestsCount: number | null
  estMinutes: number | null
  mine: boolean
  agentsRunCount: number
}
export interface TasksQuery {
  source?: TaskSource
  q?: string
  tag?: string
  mode?: 'rank' | 'run'
}
export interface TasksResponse {
  tasks: Task[]
  counts: { all: number; public: number; mine: number }
}
export interface TagsResponse {
  tags: Tag[]
}
export interface ModelRelease {
  id: string
  isLatest: boolean
}
export interface Model {
  id: string
  label: string
  provider: string
  enabled: boolean
  supportsTools: boolean
  releases: ModelRelease[]
}
export interface ModelsResponse {
  models: Model[]
}

// ---------- GitHub and agents ----------
export interface GithubInstallation {
  installationId: number
  accountLogin: string | null
}
export interface GithubRepo {
  fullName: string
  accountLogin?: string | null
  private?: boolean
  defaultBranch?: string
  installationId?: number
}
export interface GithubBranch {
  name: string
  headSha: string
}
export interface GithubCommit {
  sha: string
  shortSha: string
  message: string
  date: string
}
export interface AgentValidateInput {
  repoFullName: string
  branch: string
  agentPath: string
  commit: string
}
export interface AgentValidateResponse {
  ok: boolean
  files: Array<{ path: string; bytes: number }>
  summary: string
  commit: string
  error?: string
}
export interface AgentVersionSummary {
  id: string
  commitSha: string
  files: Array<{ path: string; size: number; sha: string }>
  createdAt: string
}
export type AgentVisibility = 'private' | 'listed'
export type AgentStatus = 'draft' | 'active'
export interface CreateAgentInput {
  repoFullName: string
  agentPath: string
  branch: string
  commit: string
  model: string
  modelRelease?: string
  name: string
  description?: string
  visibility: AgentVisibility
}
export interface Agent {
  id: string
  slug?: string
  name: string
  description?: string | null
  repoFullName?: string | null
  agentPath?: string | null
  branch?: string | null
  pinnedCommit?: string | null
  model?: string | null
  modelRelease?: string | null
  visibility?: AgentVisibility
  status?: AgentStatus
  createdAt?: string
  listedAt?: string | null
  [extra: string]: unknown
}
export interface RankingRow {
  id: string
  slug: string
  name: string
  initials: string
  authorName: string
  isMine: boolean
  when: string
  description: string
  modelLabel: string
  draft: boolean
  score: number | null
  taskCount: number
  coverage: { k: number; n: number; perTask: boolean[] }
  runCostUsd: number
  runCostLamports: number
  runCostSol: string
}
export interface PriceInfo {
  usdPerRun: number
  solUsdRate: number
  priceSource: PriceSource
}
export interface RankingResponse {
  rows: RankingRow[]
  price: PriceInfo
}
export interface RankingQuery {
  scope?: 'all' | 'mine'
  q?: string
  taskIds?: string[]
}

// ---------- Evaluations and payments ----------
export type PriceSource = 'pyth' | 'coingecko'
export interface QuoteInput {
  agentId: string
  taskIds: string[]
}
export interface Quote {
  priceUsdPerRun: number
  amountUsd: number
  solUsdRate: number
  priceSource: PriceSource
  amountLamports: number
  sol: string
  treasury: string
  reference: string
  expiresAt: string
}
export interface CreateEvaluationInput {
  agentId: string
  taskIds: string[]
  reference: string
  txSig: string
  /** Optional BYOK (Q2: Itera pays tokens; the field is not on screen 03). */
  modelApiKey?: string
  modelRelease?: string
}
export interface CreateEvaluationResponse {
  evaluationId: string
  status: 'pending'
  runs: Array<{ runId: string; taskId: string; seq: number; runStartMemo?: { wireTransactionBase64: string } }>
}
export type EvaluationStatus = 'pending' | 'in_progress' | 'review' | 'issuing' | 'issued' | 'cancelled' | 'failed'
export type EvaluationUiState = 'queued' | 'running' | 'issuing' | 'error'
export type Outcome = 'PASS' | 'FAIL' | 'INVALID'
export interface OutcomeCounts {
  pass: number
  fail: number
  invalid: number
}
export interface EvaluationListItem {
  id: string
  shortId: string
  slug: string | null
  agent: { id?: string; slug?: string | null; name: string; initials: string; authorName: string; isMine: boolean }
  createdAt: string
  feeSol: string
  feeLamports?: number
  feeUsd?: number
  tasks: Array<{ id: string; name: string }>
  counts: OutcomeCounts
  score: number | null
  status: EvaluationStatus
  share: { kind: 'link' | 'private' | 'none'; url: string | null }
}
/** The API names are all | my_agents | others; the hyphenated forms are accepted aliases. */
export type EvaluationScope = 'all' | 'my_agents' | 'others' | 'mine-agents' | 'other-agents'
export interface EvaluationsResponse {
  evaluations: EvaluationListItem[]
  totals: { spentLamports: number; spentSol: string; usd: number; counts: { all: number; myAgents: number; others: number } }
}
export type StageKey = 'contract' | 'agent_calls' | 'grading' | 'manifest' | 'attestation'
export type StageState = 'done' | 'active' | 'error' | 'wait'
export type TaskStage = 'queued' | 'awaiting_artifact' | 'grading' | 'graded' | 'timed_out'
export type EventToneApi = 'ok' | 'live' | 'idle' | 'bad'
export interface ProofSummary {
  runId: string
  status: 'pending' | 'confirmed' | 'failed'
  txSig: string | null
  nftMint: string | null
  proofHash: string | null
}
export interface EvaluationDetail {
  id: string
  shortId: string
  slug: string | null
  status: EvaluationStatus
  uiState: EvaluationUiState
  elapsedMs: number
  agent: { name: string; commit: string; initials: string }
  model: string
  taskCount: number
  stages: Array<{ key: StageKey; state: StageState; detail: string | null }>
  tasks: Array<{
    runId: string
    taskId: string
    name: string
    slug: string
    stage: TaskStage
    testsPassed: number | null
    testsTotal: number | null
    durationMs: number | null
    outcome: Outcome | null
    score: number | null
  }>
  events: Array<{ tMs: number; tone: EventToneApi; label: string; detail: string | null }>
  proofs: ProofSummary[]
  score: number | null
  counts: OutcomeCounts
  isPublic: boolean
  shareUrl: string | null
}

// ---------- Runs [EXISTING] ----------
export type RunStatus = 'queued' | 'running' | 'pass' | 'fail' | 'invalid' | 'timeout' | 'infra_error'
export type RunPhase = 'preparing' | 'agent_running' | 'grading' | 'done'
export interface Run {
  runId: string
  status: RunStatus
  phase: RunPhase | null
  scoreTotal: number | null
  evaluationId?: string | null
  durationMs?: number | null
  tests?: { public?: { passed: number; total: number }; hidden?: { passed: number; total: number; results?: boolean[] } }
  proof: { status: string; nftMint: string | null; txSig: string | null; proofHash: string | null } | null
  [extra: string]: unknown
}

// ---------- Public surface ----------
export interface PublicEvaluation {
  slug: string
  hash: string
  issuedAt: string | null
  agent: { name: string; slug: string; initials: string; authorName: string; modelLabel: string; commit: string; description: string }
  tags: Tag[]
  score: number | null
  counts: OutcomeCounts
  testsPassed: number
  testsTotal: number
  tasks: Array<{ name: string; description: string; tags: Tag[]; outcome: Outcome; testResults: boolean[]; testsPassed: number; testsTotal: number; durationMs: number | null }>
  record: {
    network: string
    status: 'Confirmed' | 'Pending'
    issuedAt: string | null
    proofs: Array<{ txSig: string; attestationAddress: string | null; nftMint: string | null; proofHash: string }>
  }
  disclaimer: string
}

// ---------- My tasks (P7) ----------
export interface TaskContract {
  instruction: string
  editable_paths: string[]
  protected_paths: string[]
  verifier: { cmd: string }
  timeout_s: number
  est_minutes: number
}
export interface CreateTaskInput {
  name: string
  description: string
  tags: string[]
  contract: TaskContract
  visibility: 'private'
}
export interface TaskVersionInput {
  source: 'github'
  repoFullName: string
  branch: string
  commit: string
  path: string
}
export interface TaskLayout {
  taskJson: boolean
  instruction: boolean
  environment: boolean
  testsPublic: boolean
  testsHidden: boolean
  solution: boolean
}
export interface TaskValidation {
  baselineHiddenFail: boolean | null
  solutionPassed: number | null
  solutionTotal: number | null
  repeatSame: number | null
  repeatTotal: number | null
  verifierSeconds: number | null
}
export interface TaskDetail extends Task {
  contract?: TaskContract
  versions: Array<{ version: number; status: TaskStatus; repoFullName?: string; repoCommit?: string; layout?: TaskLayout; validation?: TaskValidation | null; createdAt: string }>
  bestResult?: { agentName: string; score: number } | null
}
