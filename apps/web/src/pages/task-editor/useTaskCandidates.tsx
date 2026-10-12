import { useMemo } from 'react'
import { api } from '../../lib/api'
import type { TaskCandidate } from '../../lib/api'
import type { SelectOption } from '../../tma/ui'
import { useLoad } from '../add-agent/useLoad'
import type { GithubPin } from '../add-agent/useGithubSource'

/**
 * Task folders of the picked repo at the pinned commit (U34, GET /github/repos/:o/:r/task-candidates):
 * a repo can hold many tasks (tasks/<slug>/ in the Harbor layout). The options fill the path field.
 * A failed or empty answer gives no options, and the path field stays a plain input.
 */
export function useTaskCandidates(pin: GithubPin, enabled = true): { options: SelectOption[]; candidates: TaskCandidate[] } {
  const repoName = pin.repo?.fullName ?? null
  const ref = pin.commit ?? pin.branch
  const load = useLoad(() => api.githubTaskCandidates(repoName!, ref!), [repoName, ref], repoName != null && ref != null && pin.settled && enabled)
  const candidates = useMemo(() => load.data?.candidates ?? [], [load.data])
  const options = useMemo<SelectOption[]>(
    () =>
      candidates.map((c) => ({
        value: c.path,
        label: <span className="ta-mono13">{c.path === '.' ? '. (repo root)' : c.path}</span>,
        meta: c.title ?? c.slug ?? undefined,
        note: c.valid ? undefined : 'invalid',
      })),
    [candidates],
  )
  return { options, candidates }
}
