import type { TreeEntry } from "./app-client.js";

/** Total size cap of one agent snapshot (AGENTS.md + CLAUDE.md + skills/**). */
export const AGENT_FILES_MAX_BYTES = 200 * 1024;

export interface AgentFile {
  /** Path relative to the agent path. */
  path: string;
  sha: string;
  size: number;
  encoding: "utf-8" | "base64";
  content: string;
}

export class AgentPathError extends Error {}

/** Normalizes a user-given agent path: "" / "." / "/" → "."; strips slashes; rejects "..". */
export function normalizeAgentPath(input: unknown): string {
  if (input === undefined || input === null) return ".";
  if (typeof input !== "string") throw new AgentPathError("agentPath must be a string");
  const trimmed = input.trim().replace(/^\/+|\/+$/g, "");
  if (trimmed === "" || trimmed === ".") return ".";
  const parts = trimmed.split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) throw new AgentPathError("agentPath must be a plain relative directory");
  return parts.join("/");
}

function prefixOf(agentPath: string): string {
  return agentPath === "." ? "" : `${agentPath}/`;
}

const isFile = (e: TreeEntry) => e.type === "blob" && e.mode !== "120000"; // no symlinks, no submodules

/** Directories that hold an AGENTS.md or a CLAUDE.md. */
export function findAgentCandidates(entries: TreeEntry[]): { path: string; hasAgentsMd: boolean; hasClaudeMd: boolean; hasSkills: boolean }[] {
  const dirs = new Map<string, { hasAgentsMd: boolean; hasClaudeMd: boolean }>();
  for (const e of entries) {
    if (!isFile(e)) continue;
    const slash = e.path.lastIndexOf("/");
    const dir = slash === -1 ? "." : e.path.slice(0, slash);
    const name = e.path.slice(slash + 1);
    if (name !== "AGENTS.md" && name !== "CLAUDE.md") continue;
    const d = dirs.get(dir) ?? { hasAgentsMd: false, hasClaudeMd: false };
    if (name === "AGENTS.md") d.hasAgentsMd = true;
    else d.hasClaudeMd = true;
    dirs.set(dir, d);
  }
  return [...dirs.entries()]
    .map(([path, d]) => ({
      path,
      ...d,
      hasSkills: entries.some((e) => isFile(e) && e.path.startsWith(`${prefixOf(path)}skills/`)),
    }))
    .sort((a, b) => (a.path === "." ? -1 : b.path === "." ? 1 : a.path.localeCompare(b.path)));
}

export type SelectResult =
  | { ok: true; entries: (TreeEntry & { relPath: string; size: number })[]; totalBytes: number }
  | { ok: false; reason: "no_agent_file" }
  | { ok: false; reason: "too_large"; totalBytes: number };

/** Picks AGENTS.md, CLAUDE.md and skills/** under agentPath. Fails (never silently truncates) when
 * the total exceeds the cap — a run must see the exact agent the user registered. */
export function selectAgentFiles(entries: TreeEntry[], agentPath: string, maxBytes = AGENT_FILES_MAX_BYTES): SelectResult {
  const prefix = prefixOf(agentPath);
  const picked = entries
    .filter(isFile)
    .filter((e) => e.path.startsWith(prefix))
    .map((e) => ({ ...e, relPath: e.path.slice(prefix.length), size: e.size ?? 0 }))
    .filter((e) => e.relPath === "AGENTS.md" || e.relPath === "CLAUDE.md" || e.relPath.startsWith("skills/"));
  if (!picked.some((e) => e.relPath === "AGENTS.md" || e.relPath === "CLAUDE.md")) return { ok: false, reason: "no_agent_file" };
  const rank = (p: string) => (p === "AGENTS.md" ? 0 : p === "CLAUDE.md" ? 1 : 2);
  picked.sort((a, b) => rank(a.relPath) - rank(b.relPath) || a.relPath.localeCompare(b.relPath));
  const totalBytes = picked.reduce((s, e) => s + e.size, 0);
  if (totalBytes > maxBytes) return { ok: false, reason: "too_large", totalBytes };
  return { ok: true, entries: picked, totalBytes };
}

export function encodeAgentFile(relPath: string, sha: string, bytes: Buffer): AgentFile {
  const binary = bytes.includes(0);
  return {
    path: relPath,
    sha,
    size: bytes.length,
    encoding: binary ? "base64" : "utf-8",
    content: binary ? bytes.toString("base64") : bytes.toString("utf-8"),
  };
}
