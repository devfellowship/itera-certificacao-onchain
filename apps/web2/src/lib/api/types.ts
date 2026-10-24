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
  /** U36: same value as `handle`. 3–30 of a-z, 0-9, _ and -. */
  username?: string | null
  displayName: string | null
  handle: string | null
  /** U36: public URL of the 256×256 picture, or null. */
  avatarUrl?: string | null
  /** U36: one optional line, ≤ 80 characters. */
  bio?: string | null
  /** U36: GET /me only — agents and tasks the wallet owns. */
  stats?: { agents: number; tasks: number } | null
  initials: string
}
export interface UsernameAvailability {
  username: string
  available: boolean
  reason: 'taken' | 'reserved' | 'invalid' | null
  error?: string
}
/** U36: GET /public/users/:username — the page /u/:username. */
export interface PublicUser {
  user: { username: string; displayName: string | null; bio: string | null; avatarUrl: string | null; initials: string; wallet: string }
  agents: Array<{ id: string; slug: string | null; name: string; description: string | null; avatarUrl: string | null; initials: string; createdAt: string | null }>
  tasks: Array<{ id: string; slug: string; name: string; description: string | null }>
}
export interface PatchMeInput {
  displayName?: string | null
  handle?: string | null
  username?: string | null
  bio?: string | null
  /** Only null: removes the picture. Upload with POST /me/avatar. */
  avatarUrl?: null
}
/**
 * U36: the profile the API adds next to a wallet field of any response
 * (`ownerWallet` → `ownerProfile`, `authorWallet` → `authorProfile`, …). Absent when the wallet has no profile.
 */
export interface UserProfile {
  wallet: string
  username: string | null
  displayName: string | null
  avatarUrl: string | null
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
  /** U36: the author of a user task (null for an Itera task) and the profile the API joins. */
  ownerWallet?: string | null
  ownerProfile?: UserProfile
  /** [EXT U5] `curated` (TestMyAgent catalog) or a user source. */
  source?: string | null
  /** [EXT U5] e.g. `sealed-tests` | `open-tests` (Gate Q7: label only). */
  labels?: string[]
  version?: number | null
  /** [EXT U35, `include=overview`] who wrote it (curated tasks: DevFellowship). */
  author?: TaskAuthor
  /** [EXT U35, `include=overview`] distinct visible agents with a counted result. */
  agentsCount?: number
  /** Owner-visible evaluations whose task snapshot names this task. */
  evaluationCount?: number
  /** False for open-test tasks. Their history is visible, but it never produces a competitive best result. */
  rankingEligible?: boolean
  /** [EXT U35, `include=overview`] top counted result; null when none. */
  bestResult?: TaskBestResult | null
}
export interface TaskAuthor {
  wallet: string | null
  name: string
  handle: string | null
  /** U36 profile picture; the DFL icon for curated tasks. */
  avatarUrl: string | null
  isDfl: boolean
}
export interface TaskBestResult {
  agent: { id: string; slug: string | null; name: string; initials: string; avatarUrl: string | null; author: { name: string; wallet: string; avatarUrl: string | null } }
  score: number
}
export interface TasksQuery {
  source?: TaskSource
  q?: string
  tag?: string
  mode?: 'rank' | 'run'
  /** `overview` adds author, agentsCount and bestResult to every task (Tasks page). */
  include?: 'overview'
}
export interface TasksResponse {
  tasks: Task[]
  counts: { all: number; public: number; mine: number }
}
export interface TaskHistoryEvaluation {
  id: string
  shortId: string
  createdAt: string
  status: EvaluationStatus | 'graded'
  score: number | null
  counts: OutcomeCounts
  tests: { passed: number; total: number }
  /** The model of the evaluation (evaluations.model_id); the row shows its lab logo and route. */
  model?: { id: string } | null
  agent: {
    id: string
    slug: string | null
    name: string
    authorName: string
    authorWallet: string | null
    authorProfile?: UserProfile
    avatarUrl?: string | null
  }
}
export interface TaskHistoryResponse {
  task: Task & {
    createdAt: string
    updatedAt: string
    latestVersion: null | {
      id: string
      version: number
      source: string
      labels: string[]
      runnable: boolean
      hiddenTestsCount: number | null
      fixtureDigest: string | null
      hiddenDigest: string | null
      validatedAt: string | null
      createdAt: string
      packId?: string | null
      packVersion?: string | null
      sourceLink?: { provider: string; repo: string; path: string; commit: string } | null
    }
  }
  evaluations: TaskHistoryEvaluation[]
  summary: { evaluations: number; agents: number; rankingEligible: boolean }
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
/** A folder of the repo that holds a task.json (U34, GET /github/repos/:o/:r/task-candidates). */
export interface TaskCandidate {
  /** "." for the repo root. */
  path: string
  name: string | null
  slug: string | null
  title: string | null
  valid: boolean
  /** First schema or parse error when not valid. */
  error: string | null
}
export interface TaskCandidatesResponse {
  repoFullName: string
  commitSha: string
  truncatedTree: boolean
  capped: boolean
  candidates: TaskCandidate[]
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
  /** U37: "sample" reads a sample repo through the TestMyAgent installation (no install needed). */
  source?: RepoSource
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
  /** U37: "sample" for a sample repo (any wallet, no install). */
  source?: RepoSource
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
  /** U37: "sample" when registered from a TestMyAgent sample repo. */
  source?: RepoSource
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
    authorProfile?: UserProfile
    /** U36: the agent's picture; absent → the web draws a generated tile. */
    avatarUrl?: string | null
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
  history?: Array<{ id: string; score: number | null; status: string; at: string | null; taskNames: string[]; path: string }>
  price: { usdPerRun: number; solUsdRate: number | null; priceSource: string | null; runCostLamports: number | null; runCostSol: string | null; indicative: boolean }
}
export interface MyResultRow {
  task: { id: string; name: string }
  outcome: 'PASS' | 'FAIL'
  score: number
  bestOwnAgent: { id: string; name: string; score: number } | null
  evaluationId?: string | null
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
  authorProfile?: UserProfile
  /** U36: the agent's picture; absent → generated tile. */
  avatarUrl?: string | null
  isMine: boolean
  when: string | null
  description: string | null
  model?: string
  modelLabel: string
  draft: boolean
  visibility?: string
  score: number | null
  /** U27: score × task reputation; the sort key. */
  weightedScore?: number | null
  reputationWeight?: number | null
  /** U27: a counted result is on a task the agent owner wrote. */
  selfEvaluated?: boolean
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
  selection?: { taskIds: string[]; tag: string | null; excludedTaskIds?: string[] }
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
export interface QuoteTask {
  taskId: string
  slug: string
  name: string
  seq: number
  runId: string
  modelCostEstimateUsd: number | null
  baseFeeUsd: number | null
  priceUsd: number | null
  /** `history` | `list_price` = estimate + base fee; `fallback` = flat price, no estimate. */
  estimateBasis: 'history' | 'list_price' | 'fallback' | null
}
export interface Quote {
  /** [EXT U7 v2] itemized: forecast model cost + base fee per run (Tainan TG 20986). */
  quoteId?: string
  modelCostEstimateUsd?: number
  baseFeeUsd?: number
  totalUsd?: number
  totalLamports?: number
  taskCount?: number
  memo?: string
  transferUrl?: string
  evaluationId?: string
  runIds?: string[]
  tasks?: QuoteTask[]
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
/** Web2: free evaluation with the caller's OpenRouter key (no quote, no payment). */
export interface FreeEvaluationInput {
  agentId: string
  taskIds: string[]
  modelApiKey: string
  modelRelease?: string
}
export interface CreateEvaluationInput {
  /** v2 reads the agent and the tasks from the quote (by reference); kept for the legacy shape. */
  agentId?: string
  taskIds?: string[]
  reference: string
  txSig: string
  /** Optional BYOK (Q2: Itera pays tokens; the field is not on screen 03). */
  modelApiKey?: string
  modelRelease?: string
}
/** [U7 v2] POST /evaluations/quote/:reference/transaction — the one wallet prompt (transfer + Memo). */
export interface QuoteTransaction {
  /** Unsigned legacy transaction, base64; the payer is the only signer. */
  transaction: string
  memo: string
  expiresAt: string
}
export interface CreateEvaluationResponse {
  evaluationId: string
  status: 'pending' | 'existing'
  txSig?: string
  runs: Array<{ runId: string; taskId: string; seq: number; runStartMemo?: { wireTransactionBase64: string } }>
}
export type EvaluationStatus = 'pending' | 'in_progress' | 'review' | 'issuing' | 'issued' | 'cancelled' | 'failed'
export type EvaluationUiState = 'queued' | 'running' | 'issuing' | 'error' | 'issued' | 'cancelled'
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
  agent: { id?: string; slug?: string | null; name: string; initials: string; authorName: string; isMine: boolean; authorWallet?: string | null; authorProfile?: UserProfile; avatarUrl?: string | null }
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
export type TaskStage = 'queued' | 'awaiting_artifact' | 'grading' | 'graded' | 'timed_out' | 'review' | 'cancelled'
export type EventToneApi = 'ok' | 'live' | 'idle' | 'bad'
export interface ProofSummary {
  runId: string
  status: 'pending' | 'confirmed' | 'failed'
  txSig: string | null
  nftMint: string | null
  proofHash: string | null
  attestationAddress?: string | null
}
export interface EvaluationDetail {
  id: string
  shortId: string
  slug: string | null
  status: EvaluationStatus
  uiState: EvaluationUiState
  elapsedMs: number
  createdAt?: string
  agent: { id?: string; name: string; slug?: string | null; repo?: string | null; commit: string | null; initials: string; avatarUrl?: string | null; authorWallet?: string | null; authorProfile?: UserProfile }
  /** v2: `{id, release}`; the design fixtures use a label string. */
  model: string | { id: string; release: string | null }
  taskCount: number
  fee?: {
    usdPerRun: number
    perTask: Array<{ taskId: string; priceUsd?: number; baseFeeUsd?: number; modelCostEstimateUsd?: number | null; basis?: string }>
    usd: number
    lamports: number
    solUsdRate: number
    priceSource: PriceSource
    txSig: string | null
  }
  stages: Array<{ key: StageKey; state: StageState; detail: string | null }>
  tasks: Array<{
    runId: string
    slotRunId?: string
    seq?: number
    /** 2 = a free retry replaced the first attempt (Gate Q1). */
    attempts?: number
    status?: RunStatus
    phase?: RunPhase | null
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
  counts: OutcomeCounts & { review?: number; cancelled?: number; queued?: number; running?: number }
  testsPassed?: number
  testsTotal?: number
  manifestSha256?: string | null
  isPublic: boolean
  freeRetriesUsed?: number
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
  /** Model cost in USD as billed by OpenRouter (lane G). Null = not measured yet. */
  modelCostUsd?: number | null
  actionsCount?: number | null
  completedAt?: string | null
  tests?: { public?: { passed: number; total: number; failed?: number }; publicBaseline?: { passed: number; total: number; failed?: number }; hidden?: { passed: number; total: number; failed?: number; results?: boolean[] } } | null
  patch?: string | null
  patchScope?: { changedFiles: string[]; allowed: boolean } | null
  errors?: string[]
  evidence?: { executorProfile: string | null; environmentDigest: string | null; contractDigest: string | null; limitations: string[] } | null
  result?: { state?: string; verdict?: string; scored?: boolean } | null
  score?: { parts: Record<string, number> | null; version?: number; rule?: unknown } | null
  modelTokens?: { in: number; out: number } | null
  proof: { status: string; nftMint: string | null; txSig: string | null; proofHash: string | null } | null
  [extra: string]: unknown
}

/** One agent tool call of a run (GET /runs/:id/actions). `target` is sanitized by the API. */
export interface RunAction {
  seq: number
  tool: string
  target: string | null
  ok: boolean | null
  occurredAt: string
}
/** GET /runs/:id/actions?after_seq= — at most 200 rows per page. Ask again with `nextAfterSeq` while `hasMore`. */
export interface RunActionsResponse {
  runId: string
  afterSeq: number
  actions: RunAction[]
  hasMore: boolean
  nextAfterSeq: number
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
  agent: { name: string; slug: string; initials: string; authorName: string; modelLabel: string; commit: string; description: string; modelId?: string | null; commitFull?: string | null; repo?: string | null; avatarUrl?: string | null }
  owner?: { wallet: string; displayName: string | null; handle: string | null; username?: string | null; avatarUrl?: string | null } | null
  evaluatorWallet?: string | null
  /** U27: at least one task was written by the agent owner (same wallet or same GitHub account). */
  selfEvaluated?: boolean
  /** The wallet that paid for the evaluation owns the agent. */
  evaluatorIsOwner?: boolean
  agentOwnerWallet?: string | null
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
    /** U27 anti-collusion. */
    taskAuthorWallet?: string | null
    agentOwnerWallet?: string | null
    selfEvaluated?: boolean
    ranked?: boolean
    unrankedReason?: string | null
    curatedByItera?: boolean
    reputation?: TaskReputation | null
    feedback?: { matchedReality: boolean; createdAt: string } | null
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

// ---------- My tasks (P7, U19 API: apps/api/src/http/my-tasks-router.ts) ----------
/** task.json of a user task (packages/contracts TaskContract, Harbor-shaped). The repo file wins over any form (U32). */
export interface TaskContract {
  schema_version: '1.0'
  task: { name: string; version: string; description?: string; authors?: Array<{ name: string; email?: string }>; keywords?: string[] }
  metadata?: { title?: string; tags?: { tools?: string[]; concepts?: string[] }; [key: string]: unknown }
  instruction: string
  environment: { dir: string; install?: string[]; allow_internet?: false; cpus?: number; memory_mb?: number; [key: string]: unknown }
  tests: { public: string; hidden: string }
  solution: { patch: string }
  editable_paths: string[]
  protected_paths: string[]
  verifier: { cmd: string[]; report?: 'vitest-json'; timeout_sec: number }
  agent: { timeout_sec: number }
  est_minutes: number
}
/** Gate Q7: a private repo seals the hidden tests (ranked); a public repo has open tests (unranked). */
export type TestsVisibility = 'open' | 'sealed'
/** GitHub source of a task: repo + branch + pinned commit + task folder path (Gate Q4). */
export interface TaskSourceInput {
  repoFullName: string
  branch?: string
  commitSha?: string
  path?: string
  /** U37: "sample" for a sample task repo (any wallet, no install). */
  source?: RepoSource
}

/** U37: where the files of an agent / task are read from. "sample" = a TestMyAgent sample repo, no install. */
export type RepoSource = 'github' | 'sample'
/** GET /github/sample-repos (public). */
export interface SampleReposResponse {
  agents: string[]
  tasks: string[]
}
export interface TaskPin {
  repoFullName: string
  branch: string
  commitSha: string
  shortSha: string
  path: string
  repoPrivate: boolean
  testsVisibility: TestsVisibility
  ranked: boolean
  labels: string[]
}
export type TaskLayoutKey = 'taskJson' | 'instruction' | 'environment' | 'testsPublic' | 'testsHidden' | 'solution'
export interface TaskLayoutEntry {
  key: TaskLayoutKey
  path: string
  present: boolean
  files?: number
}
/** Layout check of the task folder at the pinned commit. errorCode: no_task_json | bad_json | schema | missing_entries | too_large | symlink | truncated. */
export interface TaskLayout {
  ok: boolean
  entries: TaskLayoutEntry[]
  fileCount?: number
  totalBytes?: number
  errorCode?: string
  error?: string
  schemaErrors?: string[]
}
/** POST /tasks/layout — dry run of a pin: what the API read at the commit. */
export interface TaskLayoutResponse {
  pin: TaskPin
  layout: TaskLayout
  contract: TaskContract | null
}
/** One row of the editor's VALIDATION panel, formatted by the API (counts only, never test names). */
export interface GateRow {
  key: 'baseline' | 'solution' | 'repeatability' | 'verifier_time' | 'contract' | (string & {})
  label: string
  ok: boolean
  value: string
}
export type TaskValidationStatus = 'queued' | 'running' | 'ready' | 'invalid' | 'error'
export interface TaskValidationRun {
  id: string
  taskVersionId: string
  status: TaskValidationStatus
  repeats: number
  rows: GateRow[] | null
  error: string | null
  createdAt: string
  claimedAt: string | null
  completedAt: string | null
}
export interface UserTaskVersion {
  id: string
  version: number
  source: 'github'
  github: { installationId: number; repo: string; branch: string; commitSha: string; shortSha: string; path: string }
  repoPrivate: boolean
  testsVisibility: TestsVisibility
  ranked: boolean
  labels: string[]
  runnable: boolean
  hiddenTestsCount: number | null
  digests: { fixture: string | null; hidden: string | null; solution: string | null }
  validatedAt: string | null
  validationRows: GateRow[] | null
  contract: TaskContract
  createdAt: string
}
/** GET /tasks/:id for the owner (another wallet gets the catalog view or 404). Tags are tag ids. */
export interface UserTaskDetail {
  id: string
  slug: string
  name: string
  description: string
  kind: 'user'
  visibility: 'private'
  status: TaskStatus
  estMinutes: number | null
  tags: string[]
  mine: true
  runnable: boolean
  runnableVersion: number | null
  ranked: boolean
  labels: string[]
  latestVersion: UserTaskVersion | null
  /** Newest first. */
  versions: UserTaskVersion[]
  /** Latest gate run of the latest version. */
  validation: TaskValidationRun | null
  createdAt: string
  updatedAt: string
}
export interface CreateTaskInput extends TaskSourceInput {
  name?: string
  description?: string
  /** Tag ids of GET /tags, at most 8. */
  tags?: string[]
  estMinutes?: number | null
}
export interface PatchTaskInput {
  name?: string
  description?: string
  tags?: string[]
  estMinutes?: number | null
}
export interface ValidateTaskResponse {
  validationId: string
  created: boolean
  version: number
  validation: TaskValidationRun
}

// ---------- U27: anti-collusion ----------
export interface TaskReputation {
  distinctWallets: number
  runs: number
  feedbackCount: number
  feedbackYesRate: number | null
  weight: number
  curatedByItera: boolean
}
export interface RunFeedback {
  runId: string
  wallet: string
  taskId: string | null
  matchedReality: boolean
  note: string | null
  createdAt: string
}

// ---------- U30: public task profile (/tasks/:slug) ----------
export interface McpToolView {
  name: string
  description: string
  params: string[]
  required: string[]
  inputSchema: unknown
}
export interface McpServerView {
  name: string
  description: string | null
  source: 'catalog' | 'repo'
  transport: 'stdio' | 'http'
  version: string | null
  reviewedAt: string | null
  retired: boolean
  seed: { applied: boolean; digest: string | null }
  scorerReadsState: boolean
  snapshot: { status: 'pinned' | 'pending'; capturedAt: string | null; digest: string | null; toolCount: number }
  tools: McpToolView[]
  notExposedCount: number
  allowedToolNames: string[]
}
export interface TaskResults {
  agentsEvaluated: number
  runs: number
  passRate: number | null
  medianScore: number | null
  medianDurationMs: number | null
  outcomes: { pass: number; fail: number; invalid: number }
  leaderboard: Array<{
    rank: number
    agentName: string
    agentSlug: string | null
    ownerWallet?: string | null
    ownerProfile?: UserProfile
    agentAvatarUrl?: string | null
    modelLabel: string | null
    score: number | null
    outcome: Outcome
    date: string | null
    evaluationSlug: string | null
  }>
}
export interface TaskProfile {
  id: string
  slug: string
  name: string
  description: string
  tags: Tag[]
  curatedByItera: true
  runnable: boolean
  estMinutes: number | null
  price: { usdPerRun: number; currency: 'USD'; paidIn: 'SOL'; network: 'devnet' }
  tests: { label: 'sealed' | 'open'; hiddenCount: number | null; publicCount: number | null }
  version: {
    number: number
    latest: number
    isLatest: boolean
    createdAt: string
    commit: string | null
    repoUrl: string | null
    digest: string | null
    digests: { contract: string; environment: string; mcpSchema: string | null; fixture: string | null; hidden: string | null; seeds: Array<{ server: string; digest: string | null }> }
    history: Array<{ version: number; createdAt: string; changed: Array<'Contract' | 'Environment' | 'Tests'> }>
  }
  goal: { text: string; doneWhen: string[] }
  input: {
    instruction: { text: string | null; truncated: boolean }
    repository: { repo: string | null; path: string | null; commit: string | null }
    editablePaths: string[]
    protectedPaths: string[]
  }
  output: { summary: string; checkedBy: string | null; separateContainer: true; hiddenCount: number | null }
  tools: Array<{ id: string; name: string; description: string; allowed: boolean }>
  mcp: { servers: McpServerView[]; scorerReads: string[]; snapshotDigest: string | null }
  limits: {
    runTimeoutSec: number | null
    estMinutes: number | null
    costCapUsd: number
    resources: { cpus: number | null; memoryMb: number | null; pids: number | null }
    network: 'model-gateway' | 'model-gateway+mcp'
    secrets: string[]
    mcpBootTimeoutSec: number | null
    editablePaths: string[]
    protectedPaths: string[]
  }
  /** Score version 2: hidden ratio × 100 when every gate holds, else 0. `gates`/`version` are absent on an older API. */
  scoring: { parts: Array<{ key: string; label: string; points: number; description: string }>; gates?: string[]; version?: number; total: 100 }
  reputation: TaskReputation | null
  results: TaskResults
  resultsAll: TaskResults
  links: { web: string; api: string }
}
/** GET /tasks/:idOrSlug/compatibility?agentId= (U28). */
export interface TaskCompatibility {
  taskId: string
  slug: string
  agentId: string
  compatible: boolean
  reasons: Array<{ code: 'missing_mcp_server' | 'missing_builtin_tool'; requirement: string; message: string }>
  requires: string[]
  environment: { builtin: string[]; mcp: Array<{ name: string; transport: string; allowedTools: string[] }>; runEgress: string[] }
}

/** GET /mcp-catalog (U29): one published (or not yet published) version of an Itera catalog MCP server. */
export interface McpCatalogServer {
  name: string
  version: number
  /** "name@version", the string a task.json writes in `catalog`. */
  ref: string
  status: 'unpublished' | 'published' | 'retired'
  /** image@sha256:digest; null while the image has no digest (not published). */
  image: string | null
  transport: 'stdio' | 'http'
  capabilities: string[]
  description: string | null
  license: string | null
  upstream: unknown
  /** The tools/list snapshot pinned with the version. */
  tools: Array<{ name: string; description: string | null; inputSchema: unknown }>
  commit: string | null
  syncedAt: string
}
