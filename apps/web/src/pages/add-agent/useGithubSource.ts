import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../../lib/api'
import type { AgentValidateResponse, GithubBranch, GithubCommit, GithubInstallation, GithubRepo } from '../../lib/api'
import { describeError } from './errors'
import { useLoad, type Load } from './useLoad'

/** Latest commits shown in the Pinned commit select (Gate Q4). */
export const COMMIT_LIMIT = 20

export type Validation =
  | { phase: 'idle' }
  | { phase: 'running' }
  | { phase: 'ok'; result: AgentValidateResponse }
  | { phase: 'fail'; result: AgentValidateResponse }
  | { phase: 'error'; message: string; gone: boolean }

/** Repo + branch + pinned commit of a GitHub source (Gate Q4). Shared by 02 (agent) and the task editor. */
export interface GithubPin {
  /** installations + repos the App can read. */
  source: Load<{ installations: GithubInstallation[]; repos: GithubRepo[] }>
  /** An install was started in another tab: poll until the installation shows up. */
  waiting: boolean
  startWaiting: () => void
  repos: GithubRepo[]
  repo: GithubRepo | null
  setRepo: (fullName: string) => void
  branches: Load<{ defaultBranch?: string; branches: GithubBranch[] }>
  branch: string | null
  setBranch: (name: string) => void
  commits: Load<{ headSha?: string | null; commits: GithubCommit[] }>
  /** Full SHA of the pin: the chosen commit, else HEAD, else null while unknown. */
  commit: string | null
  setCommit: (sha: string) => void
  /** Branch and commit lists answered (or failed): the pin is final. */
  settled: boolean
}

export interface GithubSource extends GithubPin {
  agentPath: string
  setAgentPath: (path: string) => void
  validation: Validation
  revalidate: () => void
}

/** "src/agent/" → "src/agent", "" → ".", "./x" → "x". Same rule as the API's normalizeAgentPath. */
export function cleanAgentPath(raw: string): string {
  const p = raw.trim().replace(/^\.\//, '').replace(/\/+$/, '')
  return p === '' ? '.' : p
}

/**
 * Installations and repos, and the branch + commit lists of the chosen repo. Changing the repo
 * resets branch and commit; changing the branch resets the commit (handoff, Branch + commit selects).
 */
export function useGithubPin(): GithubPin {
  const source = useLoad(async () => {
    const { installations } = await api.githubInstallations()
    const repos = installations.length ? (await api.githubRepos()).repos : []
    return { installations, repos }
  }, [])

  const [waiting, setWaiting] = useState(false)
  const connected = (source.data?.installations.length ?? 0) > 0
  const reposReady = (source.data?.repos.length ?? 0) > 0

  // After "Install GitHub App" opened a tab: poll. Always re-check when the user comes back to this tab.
  const { reload } = source
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible' && !reposReady) reload()
    }
    window.addEventListener('focus', onVisible)
    document.addEventListener('visibilitychange', onVisible)
    const timer = waiting && !reposReady ? window.setInterval(reload, 3000) : null
    return () => {
      window.removeEventListener('focus', onVisible)
      document.removeEventListener('visibilitychange', onVisible)
      if (timer != null) window.clearInterval(timer)
    }
  }, [waiting, reposReady, reload])
  useEffect(() => {
    if (connected && reposReady) setWaiting(false)
  }, [connected, reposReady])

  const repos = useMemo(() => source.data?.repos ?? [], [source.data])
  const [repoSel, setRepoSel] = useState<string | null>(null)
  const repo = repos.find((r) => r.fullName === repoSel) ?? repos[0] ?? null
  const repoName = repo?.fullName ?? null

  const [branchSel, setBranchSel] = useState<string | null>(null)
  const [commitSel, setCommitSel] = useState<string | null>(null)

  const setRepo = useCallback((fullName: string) => {
    setRepoSel(fullName)
    setBranchSel(null)
    setCommitSel(null)
  }, [])
  const setBranch = useCallback((name: string) => {
    setBranchSel(name)
    setCommitSel(null)
  }, [])

  const branches = useLoad(() => api.githubBranches(repoName!), [repoName], repoName != null)
  const branchList = branches.data?.branches
  const defaultBranch = branches.data?.defaultBranch ?? branchList?.find((b) => b.isDefault)?.name ?? branchList?.[0]?.name ?? repo?.defaultBranch ?? null
  const branch = branchSel && (!branchList || branchList.some((b) => b.name === branchSel)) ? branchSel : defaultBranch
  const branchesSettled = branches.status === 'ready' || branches.status === 'error'

  const commits = useLoad(() => api.githubCommits(repoName!, branch!, COMMIT_LIMIT), [repoName, branch], repoName != null && branch != null && branchesSettled)
  const commitList = commits.data?.commits
  const commit = commitSel && commitList?.some((c) => c.sha === commitSel) ? commitSel : (commitList?.[0]?.sha ?? null)
  const commitsSettled = commits.status === 'ready' || commits.status === 'error'

  return {
    source,
    waiting,
    startWaiting: () => setWaiting(true),
    repos,
    repo,
    setRepo,
    branches,
    branch,
    setBranch,
    commits,
    commit,
    setCommit: setCommitSel,
    settled: commitsSettled,
  }
}

/** Everything the Source card of 02 needs: the pin, plus the dry-run validation of the agent path at the pinned commit. */
export function useGithubSource(): GithubSource {
  const pin = useGithubPin()
  const { repo, branch, commit, settled: commitsSettled } = pin
  const repoName = repo?.fullName ?? null
  const [agentPath, setAgentPath] = useState('.')
  const [validation, setValidation] = useState<Validation>({ phase: 'idle' })
  const [retry, setRetry] = useState(0)
  const seq = useRef(0)
  const path = cleanAgentPath(agentPath)

  useEffect(() => {
    const my = ++seq.current
    if (!repoName || !branch || !commitsSettled) {
      setValidation({ phase: 'idle' })
      return
    }
    setValidation({ phase: 'running' })
    const t = window.setTimeout(() => {
      api
        .agentValidate({ repoFullName: repoName, branch, commit: commit ?? undefined, agentPath: path })
        .then(
          (result) => my === seq.current && setValidation(result.ok ? { phase: 'ok', result } : { phase: 'fail', result }),
          (e: unknown) => {
            if (my !== seq.current) return
            const status = (e as { status?: number } | null)?.status
            setValidation({ phase: 'error', message: describeError(e, 'Could not read the agent files. Try again.'), gone: status === 404 })
          },
        )
    }, 350)
    return () => {
      window.clearTimeout(t)
      seq.current++
    }
  }, [repoName, branch, commit, path, commitsSettled, retry])

  return {
    ...pin,
    agentPath,
    setAgentPath,
    validation,
    revalidate: () => setRetry((n) => n + 1),
  }
}
