import { describe, expect, it } from 'vitest'
import { artifactsOf, byteLength, defaultTab, formatBytes, kindOfPath, parsePatch, splitArtifacts, type Artifact } from './artifacts'

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
