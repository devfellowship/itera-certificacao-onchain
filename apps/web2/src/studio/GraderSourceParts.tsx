/**
 * Grader source, planted bugs and judge prompt from Git at the stored digest (plan 20261112-tma-c5-studio-area-web2,
 * task C5-SRC-SERVE; Q cd26fe07 = A). Data: GET /grader-versions/:id/source[?path=]. Read only: the page shows the text
 * that the API read from Git; it never edits it and never grades again (ADR-5, ADR-7).
 */
import { useEffect, useState } from 'react'
import { ApiError } from '../lib/api'
import { getGraderSource, shortDigest, type GraderSource, type PlantedBug, type SourceText } from './graders'
import { StateBox } from './GraderLibraryParts'

export type SourceState =
  | { state: 'loading' }
  | { state: 'ready'; data: GraderSource }
  /** 404 digest_not_in_git: no commit gives the stored digest. */
  | { state: 'not-in-git' }
  | { state: 'unavailable'; message: string }

/** A body that is not a source view (an old API, a proxy page) is treated as unavailable, never rendered. */
export function isGraderSource(v: unknown): v is GraderSource {
  const o = v as GraderSource | null
  return (
    !!o &&
    typeof o === 'object' &&
    typeof o.repo === 'string' &&
    typeof o.commit === 'string' &&
    typeof o.root === 'string' &&
    Array.isArray(o.files) &&
    !!o.file &&
    typeof o.file.path === 'string' &&
    typeof o.file.text === 'string'
  )
}

/** Loads the source of one grader version (null id: nothing to load). */
export function useGraderSource(id: string | null, path?: string): SourceState {
  const [s, setS] = useState<SourceState>({ state: 'loading' })
  useEffect(() => {
    if (!id) return
    let live = true
    setS((prev) => (prev.state === 'ready' ? prev : { state: 'loading' }))
    getGraderSource(id, path).then(
      (data) => live && setS(isGraderSource(data) ? { state: 'ready', data } : { state: 'unavailable', message: 'The source could not be read.' }),
      (e) => {
        if (!live) return
        const code = e instanceof ApiError && e.body && typeof e.body === 'object' ? (e.body as { error?: unknown }).error : null
        if (e instanceof ApiError && e.status === 404 && code === 'digest_not_in_git') setS({ state: 'not-in-git' })
        else setS({ state: 'unavailable', message: e instanceof ApiError && e.status === 503 ? 'The Git source did not answer.' : 'The source could not be read.' })
      },
    )
    return () => {
      live = false
    }
  }, [id, path])
  return s
}

/** "devfellowship/dfl-evals@55c1d75". */
export const sourceRef = (s: GraderSource) => `${s.repo}@${s.commit.slice(0, 7)}`

/** The lines of a text, without the empty line after a final newline. */
const linesOf = (text: string) => {
  const lines = text.split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** A template variable such as {{rubric}} is marked, as on the artboard. */
function Line({ text }: { text: string }) {
  const parts = text.split(/(\{\{[a-z0-9_.]+\}\})/i)
  return (
    <>
      {parts.map((p, i) =>
        /^\{\{[a-z0-9_.]+\}\}$/i.test(p) ? (
          <mark key={i} className="grd-src__var">
            {p}
          </mark>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  )
}

/** Numbered lines of one file. */
export function CodeLines({ file, testId }: { file: SourceText; testId?: string }) {
  return (
    <ol className="grd-src__lines" data-testid={testId} data-blob={file.blobSha}>
      {linesOf(file.text).map((l, i) => (
        <li key={i}>
          <code>
            <Line text={l} />
          </code>
        </li>
      ))}
    </ol>
  )
}

/** S10a: the code of the version, one file at a time, with a tab per file of the digest. */
export function SourceViewer({ s, onPick }: { s: GraderSource; onPick: (path: string) => void }) {
  return (
    <section className="grd-src" data-testid="grader-source" aria-label="Grader code">
      <div className="grd-src__head">
        <div className="grd-src__tabs" role="tablist" aria-label="Files">
          {s.files.map((f) => (
            <button
              key={f.path}
              type="button"
              role="tab"
              aria-selected={f.path === s.file.path}
              className="grd-src__tab"
              onClick={() => onPick(f.path)}
              data-testid="grader-source-file"
            >
              {f.path}
            </button>
          ))}
        </div>
        <span className="grd-src__note" title={`${s.root} at commit ${s.commit}`}>
          read only · {sourceRef(s)}
        </span>
      </div>
      <CodeLines file={s.file} testId="grader-source-text" />
    </section>
  )
}

/** The facts of the source: where the file lives and which rule ties it to the digest. */
export function SourceFacts({ s }: { s: GraderSource }) {
  return (
    <p className="tma-body-sm tma-muted" data-testid="grader-source-ref">
      From Git: <span className="grd-code">{s.repo}</span> commit <span className="grd-code" title={s.commit}>{s.commit.slice(0, 12)}</span>, folder{' '}
      <span className="grd-code">{s.root}</span>. The files hash to the stored digest by the rule <span className="grd-code">{s.rule}</span>.
    </p>
  )
}

export function SourceEmpty({ st, digest, what }: { st: Exclude<SourceState, { state: 'ready' }>; digest: string; what: string }) {
  if (st.state === 'loading') return <StateBox title="Loading" text={`Reading the ${what} from Git…`} testId="grader-source-loading" />
  if (st.state === 'not-in-git')
    return (
      <StateBox
        title={`No ${what} in Git for this digest`}
        text={`No commit of the grader source repos gives the stored digest ${shortDigest(digest)}, so this page shows no ${what}. It never shows a file that is not the graded one.`}
        testId="grader-source-empty"
      />
    )
  return <StateBox title={`The ${what} is not available`} text={st.message} testId="grader-source-unavailable" />
}

/** S10a Proof tab: the planted bugs of the version, from the same commit as the code. */
export function PlantedBugs({ bugs, proof }: { bugs: PlantedBug[]; proof: { caught: number; total: number } | null }) {
  return (
    <section className="grd-head" data-testid="grader-planted-bugs">
      {proof ? (
        <div className="grd-tally" data-testid="grader-proof-tab">
          <span>
            <b>{proof.caught}</b>caught
          </span>
          <span>
            <b>{proof.total - proof.caught}</b>missed
          </span>
          <span>
            <b>{proof.total}</b>planted
          </span>
        </div>
      ) : (
        <p className="tma-body-sm tma-muted" data-testid="grader-proof-unstored">
          No proof result is stored for this version. The list below is the planted bugs in Git; the studio does not run them.
        </p>
      )}
      <ul className="grd-runs">
        {bugs.map((b) => (
          <li key={`${b.kind}:${b.name}`} className="grd-run" data-testid="grader-planted-bug">
            <span className="grd-run__main">{b.proves || b.name}</span>
            <span className="grd-run__sub">
              {b.kind === 'fixture' ? 'fixture' : 'code mutation'} {b.name}
              {b.target ? ` · ${b.kind === 'fixture' ? 'turns red' : 'on'} ${b.target}` : ''}
            </span>
            <span className="grd-run__verdict grd-fail">{b.kind === 'fixture' ? 'must fail' : 'must flip'}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** S11a: the judge prompt and its rubric, as the judge model reads them. */
export function JudgePrompt({ s }: { s: GraderSource }) {
  if (!s.judge) return null
  const vars = new Set(s.judge.prompt.text.match(/\{\{[a-z0-9_.]+\}\}/gi) ?? []).size
  return (
    <section className="grd-src" data-testid="judge-prompt" aria-label="Judge prompt">
      <div className="grd-src__head">
        <span className="grd-caps">Prompt · {s.judge.prompt.path}</span>
        <span className="grd-src__note">
          {vars} variable{vars === 1 ? '' : 's'} · read only · {sourceRef(s)}
        </span>
      </div>
      <CodeLines file={s.judge.prompt} testId="judge-prompt-text" />
      <div className="grd-src__head grd-src__head--mid">
        <span className="grd-caps">Rubric · {s.judge.rubric.path}</span>
        <span className="grd-src__note">replaces {'{{rubric}}'}</span>
      </div>
      <CodeLines file={s.judge.rubric} testId="judge-rubric-text" />
    </section>
  )
}
