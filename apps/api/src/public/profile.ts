/**
 * The public evaluation profile view (screen 05) and its manifest download. Pure: no I/O.
 *
 * Score rules are ADR-5: the per-task score is the run's `score_total` (five parts: public 20,
 * hidden 50, regression 15, scope 10, evidence 5); the evaluation score is the mean over PASS and
 * FAIL tasks (INVALID excluded). Per-test cells are hidden-test booleans in execution order, never
 * names.
 */
import { CHAIN, IPFS_GATEWAY_URL } from "../chain/config.js";
import { digestOf } from "../domain/digest.js";
import { hasEvalLog } from "../http/runs-router.js";
import { initialsOf } from "../evaluations/rollup.js";
import type { ProfileSource, PublicRunRow } from "./store.js";

export type Outcome = "PASS" | "FAIL" | "INVALID";

/** Max points of each score part (services/evaluator score model). */
export const SCORE_PARTS = [
  { key: "public_behavior", label: "Public tests", max: 20 },
  { key: "hidden_behavior", label: "Hidden tests", max: 50 },
  { key: "regression", label: "Regression", max: 15 },
  { key: "patch_integrity_and_scope", label: "Patch scope", max: 10 },
  { key: "reproducible_evidence", label: "Evidence", max: 5 },
] as const;

export type ScorePartKey = (typeof SCORE_PARTS)[number]["key"];
export type ScoreParts = Record<ScorePartKey, number>;

const round1 = (n: number) => Math.round(n * 10) / 10;

export function outcomeOf(status: string): Outcome | null {
  if (status === "pass") return "PASS";
  if (status === "fail") return "FAIL";
  if (status === "invalid" || status === "timeout") return "INVALID";
  return null;
}

/** The effective run of each slot: a free retry replaces the run it retries. Seq order. */
export function effectiveRuns(runs: PublicRunRow[]): PublicRunRow[] {
  const byId = new Map(runs.map((r) => [r.id, r]));
  const slots = new Map<string, PublicRunRow>();
  for (const r of [...runs].sort((a, b) => a.seq - b.seq || a.startedAt.localeCompare(b.startedAt))) {
    let root = r;
    while (root.retryOfRunId && byId.get(root.retryOfRunId)) root = byId.get(root.retryOfRunId)!;
    slots.set(root.id, r);
  }
  return [...slots.values()].sort((a, b) => a.seq - b.seq);
}

function scorePartsOf(run: PublicRunRow): ScoreParts | null {
  if (!hasEvalLog(run.evidenceManifest)) return null;
  const s = run.evidenceManifest.score as unknown as Record<string, number>;
  const out = {} as ScoreParts;
  for (const p of SCORE_PARTS) out[p.key] = Number(s[p.key] ?? 0);
  return out;
}

function hiddenResults(run: PublicRunRow): boolean[] {
  if (!hasEvalLog(run.evidenceManifest)) return [];
  const cases = (run.evidenceManifest.tests.hidden as { cases?: Array<{ passed: boolean }> }).cases;
  if (Array.isArray(cases) && cases.length) return cases.map((c) => Boolean(c.passed));
  const { passed, total } = run.evidenceManifest.tests.hidden;
  return Array.from({ length: total }, (_, i) => i < passed);
}

function publicTests(run: PublicRunRow): { passed: number; total: number } | null {
  if (!hasEvalLog(run.evidenceManifest)) return null;
  const t = (run.evidenceManifest.tests as { public_after_patch?: { passed: number; total: number } }).public_after_patch;
  return t ? { passed: t.passed, total: t.total } : null;
}

function durationMs(run: PublicRunRow): number | null {
  const a = run.claimedAt ?? run.startedAt;
  if (!a || !run.completedAt) return null;
  return Math.max(0, Date.parse(run.completedAt) - Date.parse(a));
}

export function solscanTx(sig: string) {
  return `https://solscan.io/tx/${sig}?cluster=${CHAIN.CLUSTER}`;
}
export function solscanAccount(address: string) {
  return `https://solscan.io/account/${address}?cluster=${CHAIN.CLUSTER}`;
}
export function solscanToken(mint: string) {
  return `https://solscan.io/token/${mint}?cluster=${CHAIN.CLUSTER}`;
}

function shortWallet(w: string) {
  return w.length > 12 ? `${w.slice(0, 4)}…${w.slice(-4)}` : w;
}

export interface ProfileLinks {
  webBaseUrl: string;
  apiBaseUrl: string;
}

export function buildPublicProfile(src: ProfileSource, links: ProfileLinks) {
  const runs = effectiveRuns(src.runs);
  const proofByRun = new Map(src.proofs.map((p) => [p.runId, p]));
  const counts = { pass: 0, fail: 0, invalid: 0 };
  let testsPassed = 0;
  let testsTotal = 0;
  const scored: Array<{ total: number; parts: ScoreParts | null }> = [];
  let modelCostUsd = 0;
  let modelCostKnown = false;

  const tasks = runs.map((r) => {
    const meta = src.taskMeta[r.taskKey] ?? { name: r.taskKey, slug: r.taskKey, description: "", tags: [], labels: [] };
    const outcome = outcomeOf(r.status);
    if (outcome === "PASS") counts.pass++;
    else if (outcome === "FAIL") counts.fail++;
    else if (outcome === "INVALID") counts.invalid++;
    const results = hiddenResults(r);
    const passed = results.filter(Boolean).length;
    testsPassed += passed;
    testsTotal += results.length;
    const parts = scorePartsOf(r);
    if ((outcome === "PASS" || outcome === "FAIL") && r.scoreTotal !== null) scored.push({ total: r.scoreTotal, parts });
    if (r.modelCostUsd !== null) {
      modelCostUsd += r.modelCostUsd;
      modelCostKnown = true;
    }
    const proof = proofByRun.get(r.id);
    const prov = src.provenance?.[r.id];
    return {
      runId: r.id,
      // U27 anti-collusion.
      taskAuthorWallet: prov?.taskAuthorWallet ?? null,
      agentOwnerWallet: prov?.agentOwnerWallet ?? src.agent.ownerWallet,
      selfEvaluated: prov?.selfEvaluated ?? false,
      ranked: prov?.ranked ?? true,
      unrankedReason: prov?.unrankedReason ?? null,
      curatedByItera: prov?.curatedByItera ?? false,
      reputation: src.reputation?.[r.taskKey] ?? null,
      feedback: src.feedback?.[r.id] ?? null,
      name: meta.name,
      slug: meta.slug,
      description: meta.description,
      tags: meta.tags,
      labels: meta.labels,
      outcome,
      score: r.scoreTotal,
      scoreParts: parts,
      testResults: results,
      testsPassed: passed,
      testsTotal: results.length,
      publicTests: publicTests(r),
      durationMs: durationMs(r),
      proofHash: proof?.manifestSha256 ?? null,
    };
  });

  const score = scored.length ? round1(scored.reduce((a, b) => a + b.total, 0) / scored.length) : null;
  const withParts = scored.filter((s) => s.parts);
  let scoreParts: ScoreParts | null = null;
  if (withParts.length) {
    scoreParts = {} as ScoreParts;
    for (const p of SCORE_PARTS) scoreParts[p.key] = round1(withParts.reduce((a, s) => a + s.parts![p.key], 0) / withParts.length);
  }

  // Union of task tags, first-seen order.
  const tagMap = new Map<string, ProfileSource["taskMeta"][string]["tags"][number]>();
  for (const t of tasks) for (const g of t.tags) if (!tagMap.has(g.id)) tagMap.set(g.id, g);

  const proofs = runs
    .map((r) => proofByRun.get(r.id))
    .filter((p): p is NonNullable<typeof p> => Boolean(p))
    .map((p) => ({
      runId: p.runId,
      status: p.status,
      txSig: p.txSig,
      attestationAddress: p.attestationAddress,
      nftMint: p.nftMint,
      proofHash: p.manifestSha256,
      evidenceCid: p.evidenceCid,
      evidenceUrl: p.evidenceCid ? `${IPFS_GATEWAY_URL}/${p.evidenceCid}` : null,
      txUrl: p.txSig ? solscanTx(p.txSig) : null,
      nftUrl: p.nftMint ? solscanToken(p.nftMint) : null,
      attestationUrl: p.attestationAddress ? solscanAccount(p.attestationAddress) : null,
      nftImageUrl: p.nftMint ? `${links.apiBaseUrl}/nft/${p.nftMint}.png` : null,
    }));
  const allConfirmed = proofs.length > 0 && proofs.every((p) => p.status === "confirmed");
  const issuedAt = src.evaluation?.issuedAt ?? src.proofs.map((p) => p.createdAt).sort().at(-1) ?? null;

  const owner = src.owner;
  const authorName = owner ? (owner.displayName ?? (owner.handle ? `@${owner.handle}` : shortWallet(owner.wallet))) : "unknown";
  const commit = src.agent.commit ? src.agent.commit.slice(0, 7) : null;
  const n = tasks.length;
  const ev = src.evaluation;
  const enc = encodeURIComponent(src.slug);

  return {
    kind: src.kind,
    slug: src.slug,
    hash: src.hash,
    url: `${links.webBaseUrl}/e/${src.slug}`,
    issuedAt,
    agent: {
      name: src.agent.name,
      slug: src.agent.slug ?? "",
      initials: initialsOf(src.agent.name),
      authorName,
      modelLabel: src.modelLabel ?? src.modelId ?? "unknown model",
      modelId: src.modelId,
      commit: commit ?? "",
      commitFull: src.agent.commit,
      repo: src.agent.repoFullName,
      description: src.agent.description ?? "",
    },
    owner,
    evaluatorWallet: src.evaluatorWallet,
    /**
     * U27: at least one task was written by the agent owner (same wallet, or same GitHub account).
     * Curated ITERA tasks are never self-evaluated.
     */
    selfEvaluated: tasks.some((t) => t.selfEvaluated),
    /** The wallet that paid for the evaluation also owns the agent (the former `selfEvaluated`). */
    evaluatorIsOwner: Boolean(src.evaluatorWallet && src.agent.ownerWallet && src.evaluatorWallet === src.agent.ownerWallet),
    agentOwnerWallet: src.agent.ownerWallet,
    tags: [...tagMap.values()],
    score,
    scoreParts,
    scorePartsMax: Object.fromEntries(SCORE_PARTS.map((p) => [p.key, p.max])) as ScoreParts,
    counts,
    testsPassed,
    testsTotal,
    cost: {
      feeUsd: ev ? ev.feeUsd : null,
      feeLamports: ev ? ev.feeLamports : null,
      feeSol: ev ? (ev.feeLamports / 1e9).toFixed(5) : null,
      modelCostUsd: modelCostKnown ? Math.round(modelCostUsd * 1e4) / 1e4 : null,
      paymentTxSig: ev?.paymentTxSig ?? null,
    },
    tasks,
    record: {
      network: `Solana ${CHAIN.CLUSTER}`,
      status: allConfirmed ? ("Confirmed" as const) : ("Pending" as const),
      issuedAt,
      proofs,
    },
    links: {
      manifest: `${links.apiBaseUrl}/public/evaluations/${enc}/manifest.json`,
      og: `${links.apiBaseUrl}/public/evaluations/${enc}/og.png`,
      badge: `${links.apiBaseUrl}/b/${enc}.svg`,
    },
    disclaimer: `Results describe ${commit ? `commit ${commit}` : "this agent"} on ${n === 1 ? "this task" : `these ${numberWord(n)} tasks`} only. They are not a guarantee of behavior on other work.`,
  };
}

export type PublicProfile = ReturnType<typeof buildPublicProfile>;

function numberWord(n: number): string {
  return ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"][n] ?? String(n);
}

/**
 * The evaluation manifest of ADR-6, rebuilt with the same fields evaluations/rollup.ts hashes, plus
 * a check that its digest equals the stored hash. A standalone run's "manifest" is its proof.
 */
export function buildManifestDownload(src: ProfileSource, profile: PublicProfile) {
  const runs = effectiveRuns(src.runs);
  const proofByRun = new Map(src.proofs.map((p) => [p.runId, p]));
  let manifest: unknown = null;
  let manifestSha256: string | null = null;
  if (src.evaluation) {
    manifest = {
      evaluation_id: src.evaluation.id,
      agent: src.agent.id,
      commit: src.agent.commit,
      model: src.evaluation.modelId,
      tasks: src.evaluation.tasks.map((t) => ({ task_id: t.taskId, task_version_id: t.taskVersionId, slug: t.slug })),
      runs: runs.map((r) => ({
        run_id: r.id,
        manifest_sha256: proofByRun.get(r.id)?.manifestSha256 ?? null,
        outcome: outcomeOf(r.status),
        score: r.scoreTotal,
      })),
    };
    manifestSha256 = digestOf(manifest);
  }
  return {
    schema: "testmyagent-evaluation-manifest/v1",
    kind: src.kind,
    slug: src.slug,
    hash: src.hash,
    manifest,
    manifestSha256,
    hashMatches: src.evaluation ? manifestSha256 === src.hash : null,
    agent: profile.agent,
    score: profile.score,
    scoreParts: profile.scoreParts,
    counts: profile.counts,
    tasks: profile.tasks.map((t) => ({ name: t.name, slug: t.slug, outcome: t.outcome, score: t.score, scoreParts: t.scoreParts, testResults: t.testResults, proofHash: t.proofHash })),
    proofs: profile.record.proofs,
    note: "Each proof hash is the sha256 of the evidence document pinned on IPFS (evidenceUrl). Verify a proof without our server at /verify.",
  };
}
