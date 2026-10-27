/**
 * Artifacts of a run (plan TMA L14c). Pure: no React, no network, so a unit test loads it alone.
 *
 * The API stores no output file of a run. It stores the run record, the patch, the test counts and
 * the tool calls. So the artifact list is DERIVED:
 *   1. `run.json`   — the run record itself (the GET /runs/:id body). JSON.
 *   2. `patch.diff` — the unified diff (owner only). Diff.
 *   3. every file the patch ADDS: the diff holds its full content, so the text is rebuilt from the
 *      `+` lines. The type follows the extension. A binary diff holds no bytes.
 *   4. every MODIFIED (or deleted, or renamed) file: listed as a diff; only its hunks exist.
 * `Artifacts (n)` is the length of this list.
 *
 * Plan TMA L17: the API now STORES the outputs of a hosted run (GET /runs/:id/artifacts) and serves
 * their bytes to the owner. `mergeStoredArtifacts` puts those entries first and lets a stored file
 * replace the entry rebuilt from the patch. A stored entry carries no `text` until its card loads it.
 */
import type { RunArtifactEntry, RunArtifactsResponse } from '../../lib/api/types'

/** `ndjson` is `agent/trace.jsonl` (one JSON event per line): a list view, not a text view. */
export type ArtifactKind = 'json' | 'markdown' | 'html' | 'image' | 'binary' | 'text' | 'diff' | 'ndjson'

export interface Artifact {
  /** Stable id for React keys and test ids (`run.json`, `patch.diff`, `added:out/report.html`, ...). */
  id: string
  path: string
  kind: ArtifactKind
  /** UTF-8 byte length of `text`, or of the diff block for a diff, or 0 for a binary file. */
  bytes: number
  /** The rebuilt text of an added file, or the run record as pretty JSON. Absent for a diff or a binary. */
  text?: string
  /** The diff block of this file (every file that comes from the patch has one). */
  diff?: string
  /** Where the entry came from. `stored` = a file the API stored for the run (L17); its bytes load on demand. */
  source: 'run' | 'patch' | 'added' | 'modified' | 'deleted' | 'renamed' | 'stored'
  /** For `image` of a raster extension or a binary diff: the API stores no bytes. */
  note?: string
  /** L17, stored only: the path as the API lists it (`files/out/report.html`); `path` is the workspace path. */
  storedPath?: string
  /** L17, stored only: the download endpoint, relative to the API base. Never navigated to. */
  href?: string
  /** L17, stored only: the content type the API stored. */
  contentType?: string
  /** L17, stored only: `utf-8` for text, `base64` for a raster image. */
  encoding?: 'utf-8' | 'base64'
  /** L17, stored only. */
  sha256?: string
}

export interface PatchFile {
  path: string
  oldPath: string | null
  status: 'added' | 'modified' | 'deleted' | 'renamed'
  binary: boolean
  /** The raw lines of this file's block, header included. */
  lines: string[]
  /** The full content of an added text file, rebuilt from the `+` lines. Null otherwise. */
  content: string | null
}

const utf8 = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null

/** UTF-8 byte length of a string. */
export function byteLength(s: string): number {
  if (utf8) return utf8.encode(s).length
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4
      i++
    } else n += 3
  }
  return n
}

/** `14.2 KB`, `0.6 KB`, `1.3 MB`. The design shows KB with one decimal, bytes included. */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—'
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / 1024).toFixed(1)} KB`
}

const RASTER = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp'])

/** The artifact kind of a path, by extension. */
export function kindOfPath(path: string): ArtifactKind {
  const m = /\.([a-z0-9]+)$/i.exec(path)
  const ext = (m?.[1] ?? '').toLowerCase()
  if (ext === 'json') return 'json'
  if (ext === 'md' || ext === 'markdown') return 'markdown'
  if (ext === 'html' || ext === 'htm') return 'html'
  if (ext === 'svg') return 'image'
  if (RASTER.has(ext)) return 'image'
  return 'text'
}

/** True for a raster image extension: the diff never holds its bytes. */
export function isRasterPath(path: string): boolean {
  const m = /\.([a-z0-9]+)$/i.exec(path)
  return RASTER.has((m?.[1] ?? '').toLowerCase())
}

/** Strips the `a/` or `b/` prefix of a git path, and the quotes of a quoted path. */
function stripPrefix(p: string): string {
  let s = p.trim()
  if (s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1)
  if (s.startsWith('a/') || s.startsWith('b/')) s = s.slice(2)
  return s
}

/** Splits `diff --git a/x b/y` into [x, y]. Handles the common case; a path with a space in it is read from `+++`. */
function pathsOfDiffLine(line: string): [string, string] | null {
  const rest = line.slice('diff --git '.length)
  // The first " b/" is the boundary for a path without " b/" inside it; the `+++` line corrects the rest.
  const idx = rest.indexOf(' b/')
  if (idx < 0) return null
  return [stripPrefix(rest.slice(0, idx)), stripPrefix(rest.slice(idx + 1))]
}

/**
 * Parses a unified diff (git format) into file blocks. Tolerant: a block without hunks (a rename or
 * a mode change) still lists the file. A patch that is not git-formatted (`--- a/x` + `+++ b/x`
 * only) is also read.
 */
export function parsePatch(patch: string | null | undefined): PatchFile[] {
  if (!patch) return []
  const lines = patch.split('\n')
  if (lines.length && lines[lines.length - 1] === '') lines.pop()
  const blocks: string[][] = []
  let cur: string[] | null = null
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      cur = [line]
      blocks.push(cur)
      continue
    }
    if (cur === null) {
      // Text before the first block (a comment, a `From:` line) is ignored; a plain `--- ` header opens a block.
      if (line.startsWith('--- ')) {
        cur = [line]
        blocks.push(cur)
      }
      continue
    }
    // A plain (non-git) patch: a new `--- ` header after the hunks opens the next block.
    if (line.startsWith('--- ') && !cur[0]!.startsWith('diff --git ') && cur.some((l) => l.startsWith('@@'))) {
      cur = [line]
      blocks.push(cur)
      continue
    }
    cur.push(line)
  }
  return blocks.map(parseBlock)
}

function parseBlock(lines: string[]): PatchFile {
  let oldPath: string | null = null
  let newPath: string | null = null
  let status: PatchFile['status'] = 'modified'
  let binary = false
  const first = lines[0] ?? ''
  if (first.startsWith('diff --git ')) {
    const p = pathsOfDiffLine(first)
    if (p) {
      oldPath = p[0]
      newPath = p[1]
    }
  }
  let i = 0
  let firstHunk = -1
  for (; i < lines.length; i++) {
    const l = lines[i]!
    if (l.startsWith('@@')) {
      firstHunk = i
      break
    }
    if (l.startsWith('new file mode')) status = 'added'
    else if (l.startsWith('deleted file mode')) status = 'deleted'
    else if (l.startsWith('rename from ')) {
      status = 'renamed'
      oldPath = stripPrefix(l.slice('rename from '.length))
    } else if (l.startsWith('rename to ')) {
      status = 'renamed'
      newPath = stripPrefix(l.slice('rename to '.length))
    } else if (l.startsWith('Binary files ') || l.startsWith('GIT binary patch')) {
      binary = true
      const m = /^Binary files (.+) and (.+) differ$/.exec(l)
      if (m) {
        if (m[1] === '/dev/null') status = 'added'
        if (m[2] === '/dev/null') status = 'deleted'
        if (m[1] !== '/dev/null') oldPath = oldPath ?? stripPrefix(m[1]!)
        if (m[2] !== '/dev/null') newPath = newPath ?? stripPrefix(m[2]!)
      }
    } else if (l.startsWith('--- ')) {
      const p = l.slice(4).replace(/\t.*$/, '')
      if (p === '/dev/null') status = status === 'renamed' ? status : 'added'
      else oldPath = stripPrefix(p)
    } else if (l.startsWith('+++ ')) {
      const p = l.slice(4).replace(/\t.*$/, '')
      if (p === '/dev/null') status = 'deleted'
      else newPath = stripPrefix(p)
    }
  }
  const path = (status === 'deleted' ? oldPath ?? newPath : newPath ?? oldPath) ?? '(unknown)'
  let content: string | null = null
  if (status === 'added' && !binary && firstHunk >= 0) {
    const out: string[] = []
    let noNewline = false
    for (let j = firstHunk; j < lines.length; j++) {
      const l = lines[j]!
      if (l.startsWith('@@')) continue
      if (l.startsWith('+')) out.push(l.slice(1) + '\n')
      else if (l.startsWith('\\')) noNewline = true
      // ' ' or '-' lines cannot exist in an added file; ignored if present.
    }
    content = out.join('')
    if (noNewline && content.endsWith('\n')) content = content.slice(0, -1)
  } else if (status === 'added' && !binary) {
    content = ''
  }
  return { path, oldPath: status === 'renamed' || status === 'deleted' ? oldPath : null, status, binary, lines, content }
}

/** The pretty JSON of the run record, 2 spaces. */
export function runRecordText(run: unknown): string {
  return JSON.stringify(run, null, 2) + '\n'
}

/** The artifacts of a run (section 3 of the brief). `run` is the GET /runs/:id body; its `patch` is the diff or null. */
export function artifactsOf(run: { patch?: string | null } & Record<string, unknown>): Artifact[] {
  const out: Artifact[] = []
  const record = runRecordText(run)
  out.push({ id: 'run.json', path: 'run.json', kind: 'json', bytes: byteLength(record), text: record, source: 'run' })
  const patch = typeof run.patch === 'string' ? run.patch : null
  if (patch == null) return out
  out.push({ id: 'patch.diff', path: 'patch.diff', kind: 'diff', bytes: byteLength(patch), diff: patch, source: 'patch' })
  for (const f of parsePatch(patch)) {
    const diff = f.lines.join('\n') + '\n'
    if (f.status === 'added') {
      if (f.binary || isRasterPath(f.path)) {
        const raster = isRasterPath(f.path)
        out.push({ id: `added:${f.path}`, path: f.path, kind: raster ? 'image' : 'binary', bytes: 0, diff, source: 'added', note: 'binary file, content not stored' })
        continue
      }
      const text = f.content ?? ''
      out.push({ id: `added:${f.path}`, path: f.path, kind: kindOfPath(f.path), bytes: byteLength(text), text, diff, source: 'added' })
      continue
    }
    out.push({ id: `${f.status}:${f.path}`, path: f.path, kind: 'diff', bytes: byteLength(diff), diff, source: f.status, ...(f.binary ? { note: 'binary file, content not stored' } : {}) })
  }
  return out
}

/* ---------- Stored outputs (L17) ---------- */

/** The prefix of a stored file of the agent's workspace. `files/out/report.html` is the file `out/report.html` of the patch. */
export const STORED_FILES_PREFIX = 'files/'

/** The kind of a stored entry: the API's kind, except that an NDJSON file (`agent/trace.jsonl`) gets the trace list view. */
export function kindOfStored(e: RunArtifactEntry): ArtifactKind {
  if (e.contentType === 'application/x-ndjson' || /\.(jsonl|ndjson)$/i.test(e.path)) return 'ndjson'
  return e.kind
}

/** True for a stored raster image (`image/png|jpeg|gif|webp`): its bytes go to an object URL, never to text. */
export function isRasterContentType(contentType: string | undefined): boolean {
  return /^image\/(png|jpeg|jpg|gif|webp)$/i.test(contentType ?? '')
}

/** The basename of a path: `files/out/report.html` → `report.html`. */
export function basenameOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i < 0 ? path : path.slice(i + 1)
}

/** An Artifact of a stored entry (no text yet). The id is `stored:<stored path>`; the path shown is the workspace path. */
export function storedArtifact(e: RunArtifactEntry): Artifact {
  const workspace = e.path.startsWith(STORED_FILES_PREFIX) ? e.path.slice(STORED_FILES_PREFIX.length) : e.path
  return {
    id: `stored:${e.path}`,
    path: workspace,
    kind: kindOfStored(e),
    bytes: Number.isFinite(e.bytes) ? Math.max(0, e.bytes) : 0,
    source: 'stored',
    storedPath: e.path,
    href: e.href,
    contentType: e.contentType,
    encoding: e.encoding,
    sha256: e.sha256,
  }
}

/** The stored entries a human looks at first: an HTML page, a markdown article, a JSON file, an image. */
function isRichStored(a: Artifact): boolean {
  return a.kind === 'html' || a.kind === 'markdown' || a.kind === 'json' || a.kind === 'image'
}

/**
 * Merges the stored outputs of a run into the derived list (section 2 of the L17b brief).
 * Order: `result.json`, then the rich `files/*` (html, markdown, json, image), then the other stored
 * entries (`patch.diff`, `agent/*`, plain `files/*`), then the derived entries that survive.
 * A stored `files/<p>` REPLACES the derived `added:<p>` (the stored bytes are the truth); the diff of
 * that file stays on the stored entry, so the card keeps a Diff view and the Patch tab is unchanged.
 * A stored `patch.diff` drops the derived duplicate and takes its diff text. `run.json` and the
 * `modified:` entries stay. `stored === null` (404, 401, a network error, an old API) → `derived` as is.
 */
export function mergeStoredArtifacts(derived: Artifact[], stored: RunArtifactsResponse | null): Artifact[] {
  if (!stored || !Array.isArray(stored.artifacts) || stored.artifacts.length === 0) return derived
  const seen = new Set<string>()
  const entries: Artifact[] = []
  for (const e of stored.artifacts) {
    if (!e || typeof e.path !== 'string' || !e.path || seen.has(e.path)) continue
    seen.add(e.path)
    entries.push(storedArtifact(e))
  }
  const byWorkspacePath = new Map<string, Artifact>()
  for (const a of entries) if (a.storedPath!.startsWith(STORED_FILES_PREFIX)) byWorkspacePath.set(a.path, a)
  const storedPatch = entries.find((a) => a.storedPath === 'patch.diff') ?? null

  const rest: Artifact[] = []
  for (const d of derived) {
    if (d.source === 'patch' && storedPatch) {
      // The stored patch.diff is the same file; keep its diff text so the card renders without a load.
      if (d.diff != null && storedPatch.diff == null) storedPatch.diff = d.diff
      continue
    }
    if (d.source === 'added') {
      const s = byWorkspacePath.get(d.path)
      if (s) {
        if (d.diff != null) s.diff = d.diff
        continue
      }
    }
    rest.push(d)
  }

  const first = entries.filter((a) => a.storedPath === 'result.json')
  const rich = entries.filter((a) => a.storedPath !== 'result.json' && a.storedPath!.startsWith(STORED_FILES_PREFIX) && isRichStored(a))
  const others = entries.filter((a) => !first.includes(a) && !rich.includes(a))
  return [...first, ...rich, ...others, ...rest]
}

/** True for an artifact a human looks at: an HTML page, a markdown article, or a JSON file other than the run record. */
export function isRich(a: Artifact): boolean {
  return a.kind === 'html' || a.kind === 'markdown' || (a.kind === 'json' && a.id !== 'run.json')
}

/** The default tab: `artifacts` when the list holds an HTML, markdown or JSON file other than `run.json`, else `summary`. */
export function defaultTab(list: Artifact[]): 'artifacts' | 'summary' {
  return list.some(isRich) ? 'artifacts' : 'summary'
}

/**
 * The layout of the Artifacts tab: the wide card, the narrow card, and the rest in order.
 * Wide = the first HTML or markdown (a stored one comes first in a merged list). Narrow = the stored
 * `result.json` when present, else the first JSON other than `run.json`, else `run.json`.
 */
export function splitArtifacts(list: Artifact[]): { wide: Artifact | null; narrow: Artifact | null; rest: Artifact[] } {
  const wide = list.find((a) => a.kind === 'html' || a.kind === 'markdown') ?? null
  const narrow = list.find((a) => a.id === 'stored:result.json') ?? list.find((a) => a.kind === 'json' && a.id !== 'run.json') ?? list.find((a) => a.id === 'run.json') ?? null
  const rest = list.filter((a) => a !== wide && a !== narrow)
  return { wide, narrow, rest }
}

/** `mm:ss` of a duration in ms; `—` when unknown. */
export function mmss(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '—'
  const s = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(s / 60)
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

/** The short id of a run: the first 8 characters of a UUID. */
export function shortRunId(runId: string): string {
  return runId.slice(0, 8)
}
