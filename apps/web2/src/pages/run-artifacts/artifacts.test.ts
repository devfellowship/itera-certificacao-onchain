import { describe, expect, it } from 'vitest'
import type { RunArtifactEntry, RunArtifactsResponse } from '../../lib/api/types'
import { artifactsOf, basenameOf, byteLength, defaultTab, formatBytes, kindOfPath, kindOfStored, mergeStoredArtifacts, parsePatch, splitArtifacts, storedArtifact, type Artifact } from './artifacts'

const HTML = '<!doctype html>\n<html>\n<head><title>Report</title></head>\n<body><h1>Report</h1></body>\n</html>\n'
const JSON_TEXT = '{\n  "filename": "report.html",\n  "ok": true\n}\n'
const MD = '# Notes\n\n- one\n- two\n'

function added(path: string, text: string): string {
  const lines = text.replace(/\n$/, '').split('\n')
  return [`diff --git a/${path} b/${path}`, 'new file mode 100644', 'index 0000000..1111111', '--- /dev/null', `+++ b/${path}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)].join('\n') + '\n'
}

const BINARY = 'diff --git a/img.png b/img.png\nnew file mode 100644\nindex 0000000..2222222\nBinary files /dev/null and b/img.png differ\n'
const MODIFIED = ['diff --git a/src/a.ts b/src/a.ts', 'index 3333333..4444444 100644', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1,3 +1,3 @@', ' const a = 1', '-const b = 2', '+const b = 3', ' export { a, b }'].join('\n') + '\n'
const PATCH = added('out/report.html', HTML) + added('out/result.json', JSON_TEXT) + added('notes.md', MD) + BINARY + MODIFIED

const run = (patch: string | null) => ({ runId: 'r-1', status: 'pass', patch, actionsCount: 3 })

describe('parsePatch', () => {
  it('reads five file blocks with their status and rebuilds the added text exactly', () => {
    const files = parsePatch(PATCH)
    expect(files.map((f) => [f.path, f.status, f.binary])).toEqual([
      ['out/report.html', 'added', false],
      ['out/result.json', 'added', false],
      ['notes.md', 'added', false],
      ['img.png', 'added', true],
      ['src/a.ts', 'modified', false],
    ])
    expect(files[0]!.content).toBe(HTML)
    expect(files[1]!.content).toBe(JSON_TEXT)
    expect(files[2]!.content).toBe(MD)
    expect(files[3]!.content).toBeNull()
    expect(files[4]!.content).toBeNull()
  })
  it('honours "\\ No newline at end of file"', () => {
    const p = 'diff --git a/x.txt b/x.txt\nnew file mode 100644\n--- /dev/null\n+++ b/x.txt\n@@ -0,0 +1,2 @@\n+a\n+b\n\\ No newline at end of file\n'
    expect(parsePatch(p)[0]!.content).toBe('a\nb')
  })
  it('an empty patch and a null patch give no file', () => {
    expect(parsePatch('')).toEqual([])
    expect(parsePatch(null)).toEqual([])
    expect(parsePatch(undefined)).toEqual([])
  })
  it('reads a deleted file and a rename', () => {
    const p = 'diff --git a/old.txt b/old.txt\ndeleted file mode 100644\n--- a/old.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone\ndiff --git a/a.txt b/b.txt\nsimilarity index 100%\nrename from a.txt\nrename to b.txt\n'
    const files = parsePatch(p)
    expect(files.map((f) => [f.path, f.status])).toEqual([
      ['old.txt', 'deleted'],
      ['b.txt', 'renamed'],
    ])
    expect(files[1]!.oldPath).toBe('a.txt')
  })
  it('reads a plain (non-git) patch', () => {
    const p = '--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1 @@\n+hello\n--- a/m.txt\n+++ b/m.txt\n@@ -1 +1 @@\n-x\n+y\n'
    const files = parsePatch(p)
    expect(files.map((f) => [f.path, f.status, f.content])).toEqual([
      ['n.txt', 'added', 'hello\n'],
      ['m.txt', 'modified', null],
    ])
  })
})

describe('artifactsOf', () => {
  it('lists run.json, patch.diff, the 4 added files and the modified file, with types, paths, sizes and text', () => {
    const list = artifactsOf(run(PATCH))
    expect(list.map((a) => [a.id, a.kind, a.path])).toEqual([
      ['run.json', 'json', 'run.json'],
      ['patch.diff', 'diff', 'patch.diff'],
      ['added:out/report.html', 'html', 'out/report.html'],
      ['added:out/result.json', 'json', 'out/result.json'],
      ['added:notes.md', 'markdown', 'notes.md'],
      ['added:img.png', 'image', 'img.png'],
      ['modified:src/a.ts', 'diff', 'src/a.ts'],
    ])
    expect(list).toHaveLength(7)
    const by = Object.fromEntries(list.map((a) => [a.id, a])) as Record<string, Artifact>
    expect(by['added:out/report.html']!.text).toBe(HTML)
    expect(by['added:out/report.html']!.bytes).toBe(byteLength(HTML))
    expect(by['added:out/result.json']!.text).toBe(JSON_TEXT)
    expect(by['added:out/result.json']!.bytes).toBe(JSON_TEXT.length)
    expect(by['added:notes.md']!.text).toBe(MD)
    expect(by['added:img.png']!.text).toBeUndefined()
    expect(by['added:img.png']!.bytes).toBe(0)
    expect(by['added:img.png']!.note).toBe('binary file, content not stored')
    expect(by['modified:src/a.ts']!.text).toBeUndefined()
    expect(by['modified:src/a.ts']!.diff).toBe(MODIFIED)
    expect(by['patch.diff']!.diff).toBe(PATCH)
    expect(by['patch.diff']!.bytes).toBe(byteLength(PATCH))
    // run.json is the run record itself, pretty-printed; its text parses back to the run (patch included).
    expect(JSON.parse(by['run.json']!.text!)).toEqual(run(PATCH))
    expect(by['run.json']!.bytes).toBe(byteLength(by['run.json']!.text!))
  })
  it('a null patch gives run.json only; an empty patch gives run.json and an empty patch.diff', () => {
    expect(artifactsOf(run(null)).map((a) => a.id)).toEqual(['run.json'])
    const empty = artifactsOf(run(''))
    expect(empty.map((a) => a.id)).toEqual(['run.json', 'patch.diff'])
    expect(empty[1]!.bytes).toBe(0)
  })
  it('counts UTF-8 bytes, not characters', () => {
    const p = added('out/é.md', '# café ☕\n')
    const a = artifactsOf(run(p)).find((x) => x.path === 'out/é.md')!
    expect(a.text).toBe('# café ☕\n')
    expect(a.bytes).toBe(byteLength('# café ☕\n'))
    expect(a.bytes).toBe(12)
  })
})

describe('helpers', () => {
  it('kindOfPath by extension', () => {
    expect(kindOfPath('a.json')).toBe('json')
    expect(kindOfPath('a.MD')).toBe('markdown')
    expect(kindOfPath('a.markdown')).toBe('markdown')
    expect(kindOfPath('a.htm')).toBe('html')
    expect(kindOfPath('a.svg')).toBe('image')
    expect(kindOfPath('a.webp')).toBe('image')
    expect(kindOfPath('a.ts')).toBe('text')
    expect(kindOfPath('Makefile')).toBe('text')
  })
  it('formatBytes shows KB with one decimal, bytes included', () => {
    expect(formatBytes(14537)).toBe('14.2 KB')
    expect(formatBytes(600)).toBe('0.6 KB')
    expect(formatBytes(2 * 1024 * 1024)).toBe('2.0 MB')
  })
  it('defaultTab is artifacts only with a rich file beyond run.json', () => {
    expect(defaultTab(artifactsOf(run(null)))).toBe('summary')
    expect(defaultTab(artifactsOf(run(MODIFIED)))).toBe('summary')
    expect(defaultTab(artifactsOf(run(added('out/result.json', JSON_TEXT))))).toBe('artifacts')
    expect(defaultTab(artifactsOf(run(added('out/report.html', HTML))))).toBe('artifacts')
  })
  it('splitArtifacts puts the HTML wide, the JSON (not run.json) narrow, the rest after', () => {
    const { wide, narrow, rest } = splitArtifacts(artifactsOf(run(PATCH)))
    expect(wide?.path).toBe('out/report.html')
    expect(narrow?.path).toBe('out/result.json')
    expect(rest.map((a) => a.id)).toEqual(['run.json', 'patch.diff', 'added:notes.md', 'added:img.png', 'modified:src/a.ts'])
    const only = splitArtifacts(artifactsOf(run(null)))
    expect(only.wide).toBeNull()
    expect(only.narrow?.id).toBe('run.json')
    expect(only.rest).toEqual([])
  })
})

/* ---------- L17: stored outputs ---------- */

const RUN_ID = '4ecfe219-6ee3-4729-845f-9d7721ec5a3c'
function entry(path: string, over: Partial<RunArtifactEntry> = {}): RunArtifactEntry {
  const ext = path.split('.').pop() ?? ''
  const kind = ext === 'diff' ? 'diff' : ext === 'json' ? 'json' : ext === 'html' ? 'html' : ext === 'md' ? 'markdown' : ext === 'png' ? 'image' : 'text'
  const contentType = kind === 'diff' ? 'text/x-diff' : kind === 'json' ? 'application/json' : kind === 'html' ? 'text/html' : kind === 'markdown' ? 'text/markdown' : kind === 'image' ? 'image/png' : ext === 'jsonl' ? 'application/x-ndjson' : 'text/plain'
  return { path, contentType, kind, encoding: kind === 'image' ? 'base64' : 'utf-8', bytes: 100, sha256: 'ab'.repeat(32), href: `/runs/${RUN_ID}/artifacts/file?path=${encodeURIComponent(path)}`, ...over }
}
function storedView(artifacts: RunArtifactEntry[], reason: RunArtifactsResponse['reason'] = null): RunArtifactsResponse {
  return { runId: RUN_ID, resultOrigin: 'hosted', limits: { maxFileBytes: 524288, maxRunBytes: 2097152, maxCount: 25 }, reason, artifacts }
}
const STORED = storedView([entry('patch.diff', { bytes: 1234 }), entry('result.json', { bytes: 456 }), entry('agent/trace.jsonl', { bytes: 80000 }), entry('agent/stderr.txt', { bytes: 12 }), entry('files/out/report.html', { bytes: 14537 }), entry('files/out/chart.png', { bytes: 9876 })])

describe('mergeStoredArtifacts', () => {
  it('puts result.json first, then the rich files/*, then the other stored entries, then the derived list', () => {
    const derived = artifactsOf(run(PATCH))
    const list = mergeStoredArtifacts(derived, STORED)
    expect(list.map((a) => a.id)).toEqual([
      'stored:result.json',
      'stored:files/out/report.html',
      'stored:files/out/chart.png',
      'stored:patch.diff',
      'stored:agent/trace.jsonl',
      'stored:agent/stderr.txt',
      'run.json',
      'added:out/result.json',
      'added:notes.md',
      'added:img.png',
      'modified:src/a.ts',
    ])
    expect(list.filter((a) => a.path === 'patch.diff')).toHaveLength(1)
    const by = Object.fromEntries(list.map((a) => [a.id, a])) as Record<string, Artifact>
    // Every stored entry: source, href, bytes from the API, no text yet.
    for (const a of list.filter((x) => x.source === 'stored')) {
      expect(a.href!.startsWith(`/runs/${RUN_ID}/artifacts/file?path=`)).toBe(true)
      expect(a.text).toBeUndefined()
      expect(a.sha256).toBe('ab'.repeat(32))
    }
    expect(by['stored:result.json']!.kind).toBe('json')
    expect(by['stored:result.json']!.bytes).toBe(456)
    expect(by['stored:result.json']!.path).toBe('result.json')
    expect(by['stored:agent/trace.jsonl']!.kind).toBe('ndjson')
    expect(by['stored:agent/stderr.txt']!.kind).toBe('text')
    expect(by['stored:files/out/chart.png']!.kind).toBe('image')
    expect(by['stored:files/out/chart.png']!.encoding).toBe('base64')
    expect(by['stored:files/out/chart.png']!.path).toBe('out/chart.png')
    // The stored patch.diff takes the diff text of the derived duplicate, so it renders without a load.
    expect(by['stored:patch.diff']!.diff).toBe(PATCH)
    expect(by['stored:patch.diff']!.bytes).toBe(1234)
    // The derived entries that survive are the same objects.
    expect(by['run.json']).toBe(derived[0])
    expect(by['modified:src/a.ts']!.diff).toBe(MODIFIED)
  })
  it('a stored files/out/report.html replaces the derived added:out/report.html and keeps its diff', () => {
    const derived = artifactsOf(run(PATCH))
    const list = mergeStoredArtifacts(derived, STORED)
    expect(list.find((a) => a.id === 'added:out/report.html')).toBeUndefined()
    const s = list.find((a) => a.id === 'stored:files/out/report.html')!
    expect(s.path).toBe('out/report.html')
    expect(s.storedPath).toBe('files/out/report.html')
    expect(s.kind).toBe('html')
    expect(s.bytes).toBe(14537)
    expect(s.text).toBeUndefined()
    expect(s.diff).toBe(derived.find((a) => a.id === 'added:out/report.html')!.diff)
    expect(s.diff).toContain('+++ b/out/report.html')
  })
  it('stored = null, an empty list, or a list without artifacts gives the L14c list unchanged', () => {
    const derived = artifactsOf(run(PATCH))
    expect(mergeStoredArtifacts(derived, null)).toBe(derived)
    expect(mergeStoredArtifacts(derived, storedView([], 'none_stored'))).toBe(derived)
    expect(mergeStoredArtifacts(derived, { ...storedView([]), artifacts: undefined as unknown as RunArtifactEntry[] })).toBe(derived)
  })
  it('reason self_declared with an empty list leaves the derived list (run.json only) and no stored entry', () => {
    const derived = artifactsOf(run(null))
    const list = mergeStoredArtifacts(derived, storedView([], 'self_declared'))
    expect(list.map((a) => a.id)).toEqual(['run.json'])
    expect(list.some((a) => a.source === 'stored')).toBe(false)
  })
  it('skips a duplicate or malformed stored path, and a stored result.json ranks before a derived one on the narrow card', () => {
    const derived = artifactsOf(run(PATCH))
    const list = mergeStoredArtifacts(derived, storedView([entry('result.json'), entry('result.json'), { ...entry('x'), path: '' }]))
    expect(list.filter((a) => a.source === 'stored')).toHaveLength(1)
    const { wide, narrow } = splitArtifacts(mergeStoredArtifacts(derived, STORED))
    expect(wide?.id).toBe('stored:files/out/report.html')
    expect(narrow?.id).toBe('stored:result.json')
    expect(defaultTab(mergeStoredArtifacts(artifactsOf(run(null)), storedView([entry('result.json')])))).toBe('artifacts')
    expect(defaultTab(mergeStoredArtifacts(artifactsOf(run(null)), storedView([entry('agent/stderr.txt')])))).toBe('summary')
  })
  it('kindOfStored, storedArtifact and basenameOf', () => {
    expect(kindOfStored(entry('agent/trace.jsonl'))).toBe('ndjson')
    expect(kindOfStored(entry('a.txt', { contentType: 'application/x-ndjson' }))).toBe('ndjson')
    expect(kindOfStored(entry('files/notes.md'))).toBe('markdown')
    expect(storedArtifact(entry('files/a/b.txt', { bytes: -3 })).bytes).toBe(0)
    expect(storedArtifact(entry('files/a/b.txt')).id).toBe('stored:files/a/b.txt')
    expect(basenameOf('files/out/report.html')).toBe('report.html')
    expect(basenameOf('result.json')).toBe('result.json')
  })
})
