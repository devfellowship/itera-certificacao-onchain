/**
 * The evaluation roll-up, in TypeScript (ADR-2; CLAUDE.md: no DB functions). Pure: no I/O.
 *
 * Slots: one per task (seq order). A free retry (Gate Q1) replaces its slot's run; the latest
 * attempt of a slot is the effective run.
 */
import { digestOf } from "../domain/digest.js";
import { hasEvalLog } from "../http/runs-router.js";
import type { EvalProof, EvalRun, EvaluationRecord, EvaluationStatus, RollupColumns } from "./store.js";

export type UiState = "queued" | "running" | "issuing" | "issued" | "graded" | "error" | "cancelled";
export type TaskStage = "queued" | "awaiting_artifact" | "grading" | "graded" | "timed_out" | "review" | "cancelled";
export type Outcome = "PASS" | "FAIL" | "INVALID" | null;

const TERMINAL = new Set(["pass", "fail", "invalid", "timeout", "infra_error", "cancelled"]);
const PROOF_STATUSES = new Set(["pass", "fail", "invalid", "timeout"]);

export interface Slot {
  seq: number;
  /** The run named in the evaluation Memo for this slot. */
  slotRunId: string;
  run: EvalRun;
  attempts: number;
}

export function slotsOf(runs: EvalRun[]): Slot[] {
  const byId = new Map(runs.map((r) => [r.id, r]));
  const slots = new Map<string, Slot>();
  for (const r of [...runs].sort((a, b) => a.seq - b.seq)) {
    let root = r;
    while (root.retryOfRunId && byId.get(root.retryOfRunId)) root = byId.get(root.retryOfRunId)!;
    const slot = slots.get(root.id);
    if (!slot) slots.set(root.id, { seq: root.seq, slotRunId: root.id, run: r, attempts: 1 });
    else {
      slot.run = r;
      slot.attempts += 1;
    }
  }
  return [...slots.values()].sort((a, b) => a.seq - b.seq);
}

export function isTerminal(run: EvalRun): boolean {
  return TERMINAL.has(run.status);
}

/** A run that gets a proof: finished, graded, and signed (its run_start_sig = the payment tx). */
export function needsProof(run: EvalRun): boolean {
  return PROOF_STATUSES.has(run.status) && hasEvalLog(run.evidenceManifest) && Boolean(run.runStartSig);
}

export function outcomeOf(run: EvalRun): Outcome {
  switch (run.status) {
    case "pass":
      return "PASS";
    case "fail":
      return "FAIL";
    case "invalid":
    case "timeout":
      return "INVALID";
    default:
      return null;
  }
}

function stageOf(run: EvalRun): TaskStage {
  switch (run.status) {
    case "queued":
    case "pending":
      return "queued";
    case "running":
      return run.phase === "grading" ? "grading" : run.phase === "agent_running" ? "awaiting_artifact" : "queued";
    case "timeout":
      return "timed_out";
    case "infra_error":
      return "review";
    case "cancelled":
      return "cancelled";
    default:
      return "graded";
  }
}

function hiddenTests(run: EvalRun): { passed: number; total: number } | null {
  return hasEvalLog(run.evidenceManifest)
    ? { passed: run.evidenceManifest.tests.hidden.passed, total: run.evidenceManifest.tests.hidden.total }
    : null;
}

function ms(a: string | null, b: string | null): number | null {
  if (!a || !b) return null;
  return Math.max(0, Date.parse(b) - Date.parse(a));
}

function short(hash: string | null | undefined, n = 7): string | null {
  return hash ? hash.slice(0, n) : null;
}

export function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "agent"
  );
}

export interface RollupInput {
  evaluation: EvaluationRecord;
  runs: EvalRun[];
  proofs: EvalProof[];
  agent: { name: string; slug: string | null; repoFullName: string | null; initials?: string; ownerWallet?: string | null };
  agentCommit: string | null;
  nowMs: number;
}

export function rollup(input: RollupInput) {
  const { evaluation: ev, runs, proofs, agent, nowMs } = input;
  const slots = slotsOf(runs);
  const proofByRun = new Map(proofs.map((p) => [p.runId, p]));
  const effective = slots.map((s) => s.run);
  const n = slots.length || ev.taskCount;

  const counts = { pass: 0, fail: 0, invalid: 0, review: 0, cancelled: 0, queued: 0, running: 0 };
  let testsPassed = 0;
  let testsTotal = 0;
  const scored: number[] = [];
  for (const r of effective) {
    const o = outcomeOf(r);
    if (o === "PASS") counts.pass++;
    else if (o === "FAIL") counts.fail++;
    else if (o === "INVALID") counts.invalid++;
    else if (r.status === "infra_error") counts.review++;
    else if (r.status === "cancelled") counts.cancelled++;
    else if (r.status === "running") counts.running++;
    else counts.queued++;
    const t = hiddenTests(r);
    if (t) {
      testsPassed += t.passed;
      testsTotal += t.total;
    }
    // ADR-5: evaluation score = mean of the PASS and FAIL runs' scores (INVALID excluded).
    if ((o === "PASS" || o === "FAIL") && r.scoreTotal !== null) scored.push(r.scoreTotal);
  }
  const score = scored.length ? Math.round((scored.reduce((a, b) => a + b, 0) / scored.length) * 10) / 10 : null;

  const allTerminal = effective.length > 0 && effective.every(isTerminal);
  const anyStarted = runs.some((r) => r.status !== "queued" && r.status !== "pending" && r.status !== "cancelled");
  const provable = effective.filter(needsProof);
  const confirmed = provable.filter((r) => proofByRun.get(r.id)?.status === "confirmed");
  const cancelled = Boolean(ev.cancelledAt);
  // ADR-6: a free (BYOK) evaluation has no payment and no proof. Its terminal state is `graded`.
  const free = ev.paymentKind === "free_byok";

  // A free retry still to come (the issuer job inserts it on the next tick) keeps the slot open.
  const historical = ev.tasks.some((t) => t.historicalRunId);
  const retryPending = !cancelled && !historical && slots.some((s) => s.run.status === "infra_error" && s.attempts === 1);

  let status: EvaluationStatus;
  if (cancelled) status = "cancelled";
  else if (!allTerminal || retryPending) status = anyStarted || retryPending ? "in_progress" : "pending";
  else if (free) status = counts.review > 0 ? "review" : counts.pass + counts.fail + counts.invalid > 0 ? "graded" : "failed";
  else if (confirmed.length < provable.length) status = "issuing";
  else if (counts.review > 0) status = "review";
  else if (provable.length === 0) status = "failed";
  else status = "issued";

  const anyError = effective.some((r) => r.status === "timeout" || (r.status === "infra_error" && !retryPending));
  let uiState: UiState;
  if (cancelled) uiState = "cancelled";
  else if (anyError) uiState = "error";
  else if (status === "pending") uiState = "queued";
  else if (status === "in_progress") uiState = "running";
  else if (status === "issuing") uiState = "issuing";
  else if (status === "issued") uiState = "issued";
  else if (status === "graded") uiState = "graded";
  else uiState = "error";

  // ADR-6: the evaluation manifest hashes the run proofs. Computed once every run has ended.
  let manifestSha256 = ev.manifestSha256;
  if (!manifestSha256 && allTerminal && !retryPending && confirmed.length === provable.length && !cancelled) {
    manifestSha256 = digestOf({
      evaluation_id: ev.id,
      agent: ev.agentId,
      commit: input.agentCommit,
      model: ev.modelId,
      tasks: ev.tasks.map((t) => ({ task_id: t.taskId, task_version_id: t.taskVersionId, slug: t.slug })),
      runs: slots.map((s) => ({
        run_id: s.run.id,
        manifest_sha256: proofByRun.get(s.run.id)?.manifestSha256 ?? null,
        outcome: outcomeOf(s.run),
        score: s.run.scoreTotal,
      })),
    });
  }
  const slug = ev.slug ?? (manifestSha256 ? `${agent.slug ?? slugify(agent.name)}-${manifestSha256.slice(0, 4)}` : null);

  const startedAt = ev.startedAt ?? effective.map((r) => r.claimedAt).filter((x): x is string => Boolean(x)).sort()[0] ?? null;
  const completedAt =
    ev.completedAt ?? (allTerminal && !retryPending ? effective.map((r) => r.completedAt ?? ev.createdAt).sort().at(-1)! : null);
  const issuedAt = ev.issuedAt ?? (status === "issued" ? new Date(nowMs).toISOString() : null);

  const returned = effective.filter((r) => isTerminal(r) || r.phase === "grading" || r.phase === "done").length;
  const graded = effective.filter(isTerminal).length;
  const stageState = (done: boolean, active: boolean, error = false) =>
    error ? "error" : done ? "done" : active ? "active" : "wait";
  const allStages = [
    {
      key: "contract",
      state: stageState(anyStarted || allTerminal, !anyStarted && !cancelled),
      detail: `${n} task contract${n === 1 ? "" : "s"} pinned`,
    },
    {
      key: "agent_calls",
      state: stageState(returned === n, effective.some((r) => r.phase === "agent_running" || r.phase === "preparing"), effective.some((r) => r.status === "timeout")),
      detail: `${returned} of ${n} returned`,
    },
    {
      key: "grading",
      state: stageState(graded === n, effective.some((r) => r.phase === "grading"), effective.some((r) => r.status === "infra_error") && !retryPending),
      detail: `${graded} of ${n} graded`,
    },
    {
      key: "manifest",
      state: stageState(Boolean(manifestSha256) || (allTerminal && !retryPending), false),
      detail: manifestSha256 ? short(manifestSha256, 12)! : "waiting for every run",
    },
    {
      key: "attestation",
      state: stageState(provable.length > 0 && confirmed.length === provable.length && allTerminal, status === "issuing", provable.some((r) => proofByRun.get(r.id)?.status === "failed")),
      detail: `${confirmed.length} of ${provable.length} confirmed`,
    },
  ];
  // No attestation on the free path.
  const stages = free ? allStages.filter((s) => s.key !== "attestation") : allStages;

  const taskById = new Map(ev.tasks.map((t) => [t.taskId, t]));
  const tasks = slots.map((s) => {
    const r = s.run;
    const t = taskById.get(r.taskId);
    const tests = hiddenTests(r);
    return {
      runId: r.id,
      slotRunId: s.slotRunId,
      seq: s.seq,
      attempts: s.attempts,
      taskId: r.taskId,
      name: t?.name ?? r.taskId,
      slug: t?.slug ?? r.taskId,
      stage: stageOf(r),
      status: r.status,
      phase: r.phase,
      testsPassed: tests?.passed ?? null,
      testsTotal: tests?.total ?? null,
      durationMs: ms(r.claimedAt ?? r.startedAt, r.completedAt),
      outcome: outcomeOf(r),
      score: r.scoreTotal,
    };
  });

  // Event log derived from timestamps (no events table tonight). tMs is relative to creation.
  const t0 = Date.parse(ev.createdAt);
  const runsLabel = `${ev.taskCount} run${ev.taskCount === 1 ? "" : "s"}`;
  const events: Array<{ tMs: number; tone: "ok" | "live" | "idle" | "bad"; label: string; detail: string }> = [
    historical
      ? { tMs: 0, tone: "ok", label: "Historical evaluation imported", detail: `${runsLabel} · original result · no new run` }
      : free
      ? { tMs: 0, tone: "ok", label: "Evaluation queued", detail: `${runsLabel} · free · your model key` }
      : { tMs: 0, tone: "ok", label: "Payment confirmed", detail: `${runsLabel} · US$${ev.feeUsd.toFixed(2)} · tx ${short(ev.txSig, 8) ?? "—"}` },
  ];
  for (const s of slots) {
    for (const r of runs.filter((x) => x.id === s.slotRunId || x.retryOfRunId === s.slotRunId)) {
      const name = taskById.get(r.taskId)?.name ?? r.taskId;
      if (r.retryOfRunId) events.push({ tMs: Date.parse(r.startedAt) - t0, tone: "idle", label: `Free retry queued · ${name}`, detail: "platform fault, no charge" });
      if (r.claimedAt) events.push({ tMs: Date.parse(r.claimedAt) - t0, tone: "live", label: `Task started · ${name}`, detail: `run ${short(r.id, 8)}` });
      if (r.completedAt && r.status !== "cancelled") {
        const o = outcomeOf(r);
        events.push({
          tMs: Date.parse(r.completedAt) - t0,
          tone: o === "PASS" ? "ok" : o === null ? "bad" : o === "FAIL" ? "bad" : "bad",
          label: `Task ${o ?? (r.status === "infra_error" ? "REVIEW" : r.status.toUpperCase())} · ${name}`,
          detail: r.scoreTotal !== null ? `score ${r.scoreTotal}` : (r.error ?? r.status).slice(0, 120),
        });
      }
      const p = proofByRun.get(r.id);
      if (p) events.push({ tMs: Date.parse(p.createdAt) - t0, tone: p.status === "confirmed" ? "ok" : p.status === "failed" ? "bad" : "live", label: `Proof ${p.status} · ${name}`, detail: p.nftMint ? `NFT ${short(p.nftMint, 8)}` : "" });
    }
  }
  if (ev.cancelledAt) events.push({ tMs: Date.parse(ev.cancelledAt) - t0, tone: "idle", label: "Evaluation cancelled", detail: "queued runs cancelled; no refund" });
  events.sort((a, b) => a.tMs - b.tMs);

  const columns: RollupColumns = {
    status,
    score,
    passCount: counts.pass,
    failCount: counts.fail,
    invalidCount: counts.invalid,
    testsPassed,
    testsTotal,
    startedAt,
    completedAt,
    issuedAt,
    manifestSha256: manifestSha256 ?? null,
    slug,
    wipeModelKey: allTerminal && !retryPending,
  };

  return {
    columns,
    view: {
      id: ev.id,
      shortId: ev.shortId,
      slug,
      status,
      uiState,
      paymentKind: free ? "free_byok" : "solana_pay",
      elapsedMs: Math.max(0, (completedAt ? Date.parse(completedAt) : nowMs) - t0),
      createdAt: ev.createdAt,
      agent: { id: ev.agentId, name: agent.name, slug: agent.slug, repo: agent.repoFullName, commit: input.agentCommit, initials: initialsOf(agent.name), authorWallet: agent.ownerWallet ?? null },
      model: { id: ev.modelId, release: ev.modelRelease },
      taskCount: n,
      fee: {
        usdPerRun: ev.priceUsdPerRun,
        perTask: ev.tasks.map((t) => ({ taskId: t.taskId, ...(t.pricing ?? {}) })),
        usd: ev.feeUsd,
        lamports: ev.feeLamports,
        solUsdRate: ev.solUsdRate,
        priceSource: ev.priceSource,
        txSig: ev.txSig,
      },
      stages,
      tasks,
      events,
      proofs: slots
        .map((s) => proofByRun.get(s.run.id))
        .filter((p): p is EvalProof => Boolean(p))
        .map((p) => ({ runId: p.runId, status: p.status, txSig: p.txSig, nftMint: p.nftMint, proofHash: p.manifestSha256, attestationAddress: p.attestationAddress })),
      score,
      counts,
      testsPassed,
      testsTotal,
      manifestSha256: manifestSha256 ?? null,
      isPublic: ev.isPublic,
      freeRetriesUsed: ev.freeRetriesUsed,
    },
  };
}

export function initialsOf(name: string): string {
  const parts = name.replace(/[^A-Za-z0-9 ]+/g, " ").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "AG";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
}
