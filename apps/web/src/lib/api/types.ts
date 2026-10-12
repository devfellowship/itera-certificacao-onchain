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
  /** ISO date of the release (OpenRouter), when the API knows it. */
  releasedAt?: string | null
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
  /** Id of the default model (first enabled one). */
  default?: string | null
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
  shortSha?: string
  isDefault?: boolean
}
export interface GithubBranchesResponse {
  defaultBranch?: string
  branches: GithubBranch[]
}
export interface GithubCommit {
  sha: string
  shortSha: string
  message: string
  date: string
  authorName?: string
  isHead?: boolean
}
export interface GithubCommitsResponse {
  branch?: string
  headSha?: string | null
  commits: GithubCommit[]
}
export interface GithubCallbackParams {
  installation_id: string
  code?: string
  state?: string
  setup_action?: string
}
export interface GithubCallbackResponse {
  installationId: number
  accountLogin: string | null
  ownerWallet: string
}
export interface AgentValidateInput {
  repoFullName: string
  /** Defaults to the repo default branch on the API. */
  branch?: string
  /** Defaults to the branch HEAD on the API. Full or short (7+) SHA. */
  commit?: string
  /** Directory that holds AGENTS.md / CLAUDE.md. "." is the repo root. */
  agentPath: string
}
/** `ok:false` answers 200 with an `errorCode` (no_agent_file | too_large) and `candidates`. */
export interface AgentValidateResponse {
  ok: boolean
  files: Array<{ path: string; bytes: number }>
  /** "AGENTS.md + 3 skills · 41 KB"; null when ok is false. */
  summary: string | null
  commit: string
  shortCommit?: string
  branch?: string
  skillCount?: number
  totalBytes?: number
  errorCode?: 'no_agent_file' | 'too_large' | (string & {})
  error?: string
  /** Paths that do hold an agent file, offered when the chosen path has none. */
  candidates?: string[]
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
// ---------- Agent profile (screen 08) [U15] ----------
export interface AgentProfileTagCount {
  id: string
  name: string
  kind: TagKind
  count: number
}
export interface AgentEvidenceRow {
  taskId: string | null
  taskSlug: string | null
  name: string
  tags: Array<{ id: string; name: string }>
  outcome: 'PASS' | 'FAIL'
  score: number
  testsPassed: number | null
  testsTotal: number | null
  at: string
  attestation: { status: string; txSig: string | null; short: string | null; explorerUrl: string | null } | null
  evaluation: { slug: string; shortId: string | null } | null
}
export interface AgentProfile {
  agent: {
    id: string
    slug: string | null
    name: string
    initials: string
    description: string | null
    authorName: string
    authorWallet: string
    isMine: boolean
    listedAt: string | null
    visibility: string
    draft: boolean
  }
  source: { repoFullName: string | null; branch: string | null; agentPath: string | null; commit: string | null; commitShort: string | null }
  model: { id: string; label: string; release: string | null }
  stats: { score: number | null; tasksEvaluated: number; evaluations: number; lastVerifiedAt: string | null }
  tags: AgentProfileTagCount[]
  evidence: AgentEvidenceRow[]
  latestAttestation: {
    network: string
    status: 'confirmed'
    issuedAt: string
    txSig: string
    txShort: string
    explorerUrl: string
    evaluationSlug: string | null
  } | null
  evaluations: Array<{
    id: string
    shortId: string | null
    slug: string | null
    score: number | null
    issuedAt: string | null
    taskCount: number
    counts: OutcomeCounts
    profilePath: string | null
  }>
  /** Present when the agent has a public profile (README badge, U16). `path` is relative to the API base. */
  badge: { path: string; markdownLinkPath: string | null } | null
}
export interface AgentProfileResponse extends AgentProfile {
  price: { usdPerRun: number; solUsdRate: number | null; priceSource: string | null; runCostLamports: number | null; runCostSol: string | null; indicative: boolean }
}
export interface MyResultRow {
  task: { id: string; name: string }
  outcome: 'PASS' | 'FAIL'
  score: number
  bestOwnAgent: { id: string; name: string; score: number } | null
}
export interface AgentMyResultsResponse {
  results: MyResultRow[]
}

/**
 * Row of GET /agents/ranking (U8, PR #50). `rank` counts only scored rows over the whole result;
 * `when` is an ISO timestamp (listedAt, else createdAt); `coverage` is null when no task is selected;
 * the run cost is null when no task is selected, and `runCostSol` is null when the rate is unknown.
 * The optional fields are on the real API and absent from the design fixtures.
 */
export interface RankingRow {
  rank?: number | null
  id: string
  slug: string | null
  name: string
  initials: string
  authorName: string
  authorWallet?: string
  isMine: boolean
  when: string | null
  description: string | null
  model?: string
  modelLabel: string
  draft: boolean
  visibility?: string
  score: number | null
  taskCount: number
  coverage: { k: number; n: number; perTask: boolean[] } | null
  runCostUsd: number | null
  runCostLamports: number | null
  runCostSol: string | null
}
export interface PriceInfo {
  usdPerRun: number
  solUsdRate: number | null
  priceSource: PriceSource | null
  at?: string | null
  /** The ranking price is indicative; the quote of POST /evaluations/quote is the binding one. */
  indicative?: boolean
}
export interface RankingResponse {
  rows: RankingRow[]
  counts?: { all: number; mine: number }
  selection?: { taskIds: string[]; tag: string | null }
  price: PriceInfo
}
export interface RankingQuery {
  scope?: 'all' | 'mine'
  q?: string
  taskIds?: string[]
  /** Adds the tasks of one tag to the selection. */
  tag?: string
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
/** The five score parts of a run (services/evaluator): public 20, hidden 50, regression 15, scope 10, evidence 5. */
export type ScorePartKey = 'public_behavior' | 'hidden_behavior' | 'regression' | 'patch_integrity_and_scope' | 'reproducible_evidence'
export type ScoreParts = Record<ScorePartKey, number>

/** GET /public/evaluations/:slugOrHash (U14). Fields marked optional arrived with U14; fixtures may omit them. */
export interface PublicEvaluation {
  kind?: 'evaluation' | 'run'
  slug: string
  hash: string
  url?: string
  issuedAt: string | null
  agent: { name: string; slug: string; initials: string; authorName: string; modelLabel: string; commit: string; description: string; modelId?: string | null; commitFull?: string | null; repo?: string | null }
  owner?: { wallet: string; displayName: string | null; handle: string | null } | null
  evaluatorWallet?: string | null
  /** The wallet that paid for the evaluation owns the agent. */
  selfEvaluated?: boolean
  tags: Tag[]
  score: number | null
  scoreParts?: ScoreParts | null
  scorePartsMax?: ScoreParts
  counts: OutcomeCounts
  testsPassed: number
  testsTotal: number
  cost?: { feeUsd: number | null; feeLamports: number | null; feeSol: string | null; modelCostUsd: number | null; paymentTxSig: string | null }
  tasks: Array<{
    name: string
    description: string
    tags: Tag[]
    outcome: Outcome | null
    testResults: boolean[]
    testsPassed: number
    testsTotal: number
    durationMs: number | null
    runId?: string
    slug?: string
    /** task_versions.labels: 'open-tests' | 'sealed-tests' (Q7, label only). */
    labels?: string[]
    score?: number | null
    scoreParts?: ScoreParts | null
    publicTests?: { passed: number; total: number } | null
    proofHash?: string | null
  }>
  record: {
    network: string
    status: 'Confirmed' | 'Pending'
    issuedAt: string | null
    proofs: Array<{
      txSig: string | null
      attestationAddress: string | null
      nftMint: string | null
      proofHash: string | null
      runId?: string
      status?: 'pending' | 'confirmed' | 'failed'
      evidenceCid?: string | null
      evidenceUrl?: string | null
      txUrl?: string | null
      nftUrl?: string | null
      attestationUrl?: string | null
      nftImageUrl?: string | null
    }>
  }
  links?: { manifest: string; og: string; badge: string }
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
