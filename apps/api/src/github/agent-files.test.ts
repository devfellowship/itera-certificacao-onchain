import { describe, expect, it } from "vitest";
import { selectAgentFiles, summarizeAgentFiles } from "./agent-files.js";
import type { TreeEntry } from "./app-client.js";

const blob = (path: string, size = 10): TreeEntry => ({ path, type: "blob", mode: "100644", sha: `sha-${path}`, size });

describe("selectAgentFiles with POLICY.md", () => {
  it("picks an optional POLICY.md after AGENTS.md and CLAUDE.md and before skills", () => {
    const result = selectAgentFiles([blob("skills/a/SKILL.md"), blob("POLICY.md"), blob("CLAUDE.md"), blob("AGENTS.md"), blob("README.md")], ".");
    expect(result.ok && result.entries.map((e) => e.relPath)).toEqual(["AGENTS.md", "CLAUDE.md", "POLICY.md", "skills/a/SKILL.md"]);
  });

  it("selects exactly the same files as before when there is no POLICY.md", () => {
    const result = selectAgentFiles([blob("skills/a/SKILL.md"), blob("CLAUDE.md"), blob("AGENTS.md"), blob("README.md")], ".");
    expect(result.ok && result.entries.map((e) => e.relPath)).toEqual(["AGENTS.md", "CLAUDE.md", "skills/a/SKILL.md"]);
  });

  it("a POLICY.md alone is not an agent", () => {
    expect(selectAgentFiles([blob("POLICY.md")], ".")).toEqual({ ok: false, reason: "no_agent_file" });
  });

  it("reads POLICY.md only at the package root, not above or below it", () => {
    const entries = [blob("POLICY.md"), blob("agents/loop/AGENTS.md"), blob("agents/loop/POLICY.md"), blob("agents/loop/nested/POLICY.md"), blob("agents/loop/POLICY.md.bak")];
    const result = selectAgentFiles(entries, "agents/loop");
    expect(result.ok && result.entries.map((e) => e.relPath)).toEqual(["AGENTS.md", "POLICY.md"]);
  });

  it("counts POLICY.md toward the size cap", () => {
    expect(selectAgentFiles([blob("AGENTS.md", 5), blob("POLICY.md", 10)], ".", 12)).toMatchObject({ ok: false, reason: "too_large", totalBytes: 15 });
  });
});

describe("summarizeAgentFiles with POLICY.md", () => {
  it("names POLICY.md in the summary", () => {
    expect(summarizeAgentFiles([{ path: "AGENTS.md", size: 10 }, { path: "POLICY.md", size: 10 }]).summary).toBe("AGENTS.md + POLICY.md · 20 B");
  });
  it("leaves the summary of a package without POLICY.md unchanged", () => {
    expect(summarizeAgentFiles([{ path: "AGENTS.md", size: 10 }, { path: "skills/a/SKILL.md", size: 10 }]).summary).toBe("AGENTS.md + 1 skill · 20 B");
  });
});
