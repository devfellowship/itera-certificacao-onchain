/** The 0021 schema probe: fail safe before the migration, cache `true`, re-ask `false` once a minute. */
import { beforeEach, describe, expect, it } from "vitest";
import { hasSelfDeclaredSchema, hostedOnly, resetSchemaFeatures } from "./schema-features.js";

const db = (answers: Array<number | Error>) => {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    query: async () => {
      const a = answers[Math.min(calls++, answers.length - 1)]!;
      if (a instanceof Error) throw a;
      return { rows: Array.from({ length: a }, () => ({ "?column?": 1 })) };
    },
  };
};

describe("hasSelfDeclaredSchema", () => {
  beforeEach(() => resetSchemaFeatures());

  it("answers false before 0021, and re-asks only after 60 s", async () => {
    const d = db([0, 1]);
    expect(await hasSelfDeclaredSchema(d, 1_000)).toBe(false);
    expect(await hasSelfDeclaredSchema(d, 30_000)).toBe(false);
    expect(d.calls).toBe(1);
    expect(await hasSelfDeclaredSchema(d, 62_000)).toBe(true);
    expect(d.calls).toBe(2);
  });

  it("caches true for the life of the process", async () => {
    const d = db([1, 0]);
    expect(await hasSelfDeclaredSchema(d, 0)).toBe(true);
    expect(await hasSelfDeclaredSchema(d, 10_000_000)).toBe(true);
    expect(d.calls).toBe(1);
  });

  it("answers false when the probe itself fails", async () => {
    expect(await hasSelfDeclaredSchema(db([new Error("connection refused")]), 0)).toBe(false);
  });

  it("adds the hosted-only filter only when the column exists", () => {
    expect(hostedOnly(false, "r")).toBe("");
    expect(hostedOnly(true, "r")).toBe(" and r.result_origin = 'hosted'");
  });
});
