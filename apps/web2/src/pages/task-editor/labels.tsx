import type { TestsVisibility } from '../../lib/api'

/** 12 px lock: "Private" marker of a user task (handoff: visibility is always private). */
export function LockIcon({ title }: { title: string }) {
  return (
    <svg className="tmt-lock" width="12" height="12" viewBox="0 0 12 12" fill="none" role="img" aria-label={title}>
      <title>{title}</title>
      <rect x="2.5" y="5.5" width="7" height="5" rx="1" stroke="currentColor" />
      <path d="M4 5.5V4a2 2 0 0 1 4 0v1.5" stroke="currentColor" />
    </svg>
  )
}

/**
 * Gate Q7 label: a private repo seals the hidden tests and the task is ranked; a public repo has
 * open tests (agent authors can read them) and its runs are unranked.
 */
export function TestsLabel({ visibility, short }: { visibility: TestsVisibility; short?: boolean }) {
  const sealed = visibility === 'sealed'
  const full = sealed ? 'Sealed tests · private repo' : 'Open tests · public repo'
  return (
    <span className={sealed ? 'tmt-tests tmt-tests--sealed' : 'tmt-tests tmt-tests--open'} title={full} data-testid={`tests-${visibility}`}>
      {short ? (sealed ? 'Sealed' : 'Open') : full}
    </span>
  )
}
