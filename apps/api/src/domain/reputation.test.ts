import { describe, expect, it } from "vitest";
import { isRankedTask, isSelfEvaluated, taskReputation, unrankedReason } from "./reputation.js";

const userTask = { kind: "user", source: "github", repoPrivate: true, labels: [] as string[], authorWallet: "W1", githubAccount: "alice" };

describe("U27 sealed-test rule", () => {
  it("ranks curated tasks and private-repo user tasks only", () => {
    expect(isRankedTask(null)).toBe(true); // legacy curated pack
    expect(isRankedTask({ kind: "itera", source: "curated", repoPrivate: null, labels: ["sealed-tests"] })).toBe(true);
    expect(isRankedTask(userTask)).toBe(true);
    expect(isRankedTask({ ...userTask, repoPrivate: false })).toBe(false);
    expect(isRankedTask({ ...userTask, repoPrivate: null })).toBe(false); // unknown fails closed
    expect(isRankedTask({ kind: "itera", source: "curated", repoPrivate: null, labels: ["open-tests"] })).toBe(false);
    expect(unrankedReason({ ...userTask, repoPrivate: false })).toBe("public-repo");
    expect(unrankedReason({ ...userTask, labels: ["open-tests"] })).toBe("open-tests");
    expect(unrankedReason(userTask)).toBeNull();
  });
});

describe("U27 self-evaluated label", () => {
  it("same wallet, or same GitHub account; never for curated tasks", () => {
    expect(isSelfEvaluated(userTask, { ownerWallet: "W1", githubAccount: "bob" })).toBe(true);
    expect(isSelfEvaluated(userTask, { ownerWallet: "W2", githubAccount: "ALICE" })).toBe(true);
    expect(isSelfEvaluated(userTask, { ownerWallet: "W2", githubAccount: "bob" })).toBe(false);
    expect(isSelfEvaluated({ kind: "itera", authorWallet: null, githubAccount: null }, { ownerWallet: "W1", githubAccount: null })).toBe(false);
    expect(isSelfEvaluated(null, { ownerWallet: "W1", githubAccount: "alice" })).toBe(false);
  });
});

describe("U27 task reputation", () => {
  it("curated weighs 1; a user task weighs wallet trust × smoothed yes-rate", () => {
    expect(taskReputation({ kind: "itera", distinctWallets: 0, runs: 0, feedbackYes: 0, feedbackTotal: 0 }).weight).toBe(1);
    expect(taskReputation({ kind: "itera", distinctWallets: 0, runs: 0, feedbackYes: 0, feedbackTotal: 0 }).curatedByItera).toBe(true);
    const lonely = taskReputation({ kind: "user", distinctWallets: 0, runs: 3, feedbackYes: 0, feedbackTotal: 0 });
    expect(lonely.weight).toBe(0);
    expect(lonely.feedbackYesRate).toBeNull();
    const busy = taskReputation({ kind: "user", distinctWallets: 5, runs: 20, feedbackYes: 8, feedbackTotal: 8 });
    expect(busy.weight).toBe(0.9); // 1 × 9/10
    expect(busy.feedbackYesRate).toBe(1);
    const doubted = taskReputation({ kind: "user", distinctWallets: 5, runs: 20, feedbackYes: 0, feedbackTotal: 8 });
    expect(doubted.weight).toBe(0.1);
  });
});
