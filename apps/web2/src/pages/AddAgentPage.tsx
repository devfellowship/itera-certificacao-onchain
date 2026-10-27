import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { api } from '../lib/api'
import { HOSTED_RUNS_ENABLED } from '../config'
import { Breadcrumb, Button, Card, Field, Input, KeyValue, RadioCard, Stepper } from '../tma/ui'
import { AgentFilesPanel } from './add-agent/AgentFilesPanel'
import { describeError } from './add-agent/errors'
import { GithubSourceCard, SampleRepoNotice } from './add-agent/GithubSourceCard'
import { LocalAgentPage } from './add-agent/LocalAgentForm'
import { SourceChoice, type AgentSource } from './add-agent/SourceChoice'
import { ModelCard } from './add-agent/ModelCard'
import { cleanAgentPath, useGithubSource } from './add-agent/useGithubSource'
import { useLoad } from './add-agent/useLoad'
import { renderCrop } from './profile-settings/AvatarCropper'
import './add-agent/add-agent.css'

const DESC_MAX = 90
const STEPS = ['Agent', 'Tasks', 'Evaluation', 'Results']

/** "settlewise-agent" → "Settlewise": the name proposed from the repo until the user types one. */
function nameFromRepo(fullName: string | undefined): string {
  const base = (fullName ?? '').split('/').pop() ?? ''
  const words = base.split(/[-_.\s]+/).filter(Boolean)
  if (words.length > 1 && /^agents?$/i.test(words[words.length - 1])) words.pop()
  return words
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ')
}

/**
 * Screen 02 Add agent. The source picker (L11) chooses between the GitHub flow (U10, the default) and a local
 * agent that runs on the owner's machine. `/agents/new?source=local` opens the local form directly.
 */
export function AddAgentPage() {
  const [params, setParams] = useSearchParams()
  const source: AgentSource = params.get('source') === 'local' ? 'local' : 'github'
  const setSource = (next: AgentSource) =>
    setParams(
      (prev) => {
        const n = new URLSearchParams(prev)
        next === 'local' ? n.set('source', 'local') : n.delete('source')
        return n
      },
      { replace: true },
    )
  const picker = <SourceChoice value={source} onChange={setSource} />
  if (source === 'local') return <LocalAgentPage picker={picker} />
  return <GithubAgentPage picker={picker} />
}

/** Screen 02 Add agent (U10): register an agent from a GitHub repo, pinned to a commit. */
function GithubAgentPage({ picker }: { picker: ReactNode }) {
  const navigate = useNavigate()
  const gh = useGithubSource()
  const models = useLoad(() => api.models(), [])

  const [nameEdit, setNameEdit] = useState<string | null>(null)
  const [description, setDescription] = useState('')
  const [visibility, setVisibility] = useState<'private' | 'listed'>('listed')
  const [modelSel, setModelSel] = useState<string | null>(null)
  const [releaseSel, setReleaseSel] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  // U36 (TG 21086): the agent picture, picked here and uploaded once the agent exists.
  const [picture, setPicture] = useState<{ blob: Blob; url: string } | null>(null)
  const [pictureError, setPictureError] = useState<string | null>(null)
  const pictureInput = useRef<HTMLInputElement>(null)

  async function pickPicture(file: File | undefined) {
    setPictureError(null)
    if (!file) return
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) return setPictureError('PNG, JPG or WebP only.')
    if (file.size > 2 * 1024 * 1024) return setPictureError('Max 2 MB.')
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const i = new Image()
        i.onload = () => resolve(i)
        i.onerror = () => reject(new Error('unreadable'))
        i.src = URL.createObjectURL(file)
      })
      // Centered square crop at 256 px; the API re-encodes it (256×256 WebP, no metadata).
      const blob = await renderCrop({ img, zoom: 1, x: 0, y: 0 })
      setPicture((old) => {
        if (old) URL.revokeObjectURL(old.url)
        return { blob, url: URL.createObjectURL(blob) }
      })
    } catch {
      setPictureError('This file is not a readable image.')
    }
  }

  const name = nameEdit ?? nameFromRepo(gh.repo?.fullName)

  const enabled = useMemo(() => models.data?.models.filter((m) => m.enabled) ?? [], [models.data])
  const model = enabled.find((m) => m.id === modelSel) ?? enabled.find((m) => m.id === models.data?.default) ?? enabled[0] ?? null
  const release = model?.releases.find((r) => r.id === releaseSel) ?? model?.releases.find((r) => r.isLatest) ?? model?.releases[0] ?? null

  // Hand the "?github=…" hint of the callback page a chance to refresh the lists once.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).has('github')) gh.source.reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const verified = gh.validation.phase === 'ok'
  const canContinue = verified && name.trim().length > 0 && model != null && !saving

  async function submit() {
    if (!canContinue || !gh.repo || !gh.branch || !model) return
    setSaving(true)
    setSaveError(null)
    try {
      const { agent } = await api.createAgent({
        repoFullName: gh.repo.fullName,
        agentPath: cleanAgentPath(gh.agentPath),
        branch: gh.branch,
        commit: gh.commit ?? '',
        model: model.id,
        modelRelease: release?.id,
        name: name.trim(),
        description: description.trim() || undefined,
        visibility,
        ...(gh.sample ? { source: 'sample' as const } : {}),
      })
      if (picture) {
        // Best effort: a failed picture never blocks the agent; the owner can retry later.
        await api.uploadAgentAvatar(agent.id, picture.blob, 'agent.png').catch(() => undefined)
      }
      // L15b: with hosted runs off (web2 = ingested only, Tainan TG 23889) the next step is the agent page, not a run.
      navigate(HOSTED_RUNS_ENABLED ? `/agents/${encodeURIComponent(agent.id)}/evaluate` : `/agents/${encodeURIComponent(agent.id)}`)
    } catch (e) {
      setSaveError(describeError(e, 'Could not save the agent. Try again.'))
      setSaving(false)
    }
  }

  return (
    <main className="tma-page tma-page--flow" data-testid="add-agent-page">
      <div className="ta-head">
        <Breadcrumb items={[{ label: 'Agents', to: '/agents' }, { label: 'New agent' }]} />
        <div className="ta-head__row">
          <h1 className="tma-h1">Add agent</h1>
          <Stepper steps={STEPS} current={0} />
        </div>
        {picker}
      </div>

      <div className="ta-grid">
        <div className="ta-col">
          <Card className="ta-card">
            <span className="tma-label">Identity</span>
            <div className="ta-identity">
              <div className="ta-avatar-col">
                <div className="ta-avatar" aria-hidden="true" data-testid="agent-picture">
                  {picture ? <img src={picture.url} alt="" /> : (name || '?').slice(0, 2)}
                </div>
                <button type="button" className="ta-upload" onClick={() => pictureInput.current?.click()} data-testid="agent-picture-upload">
                  Upload
                </button>
                {pictureError && <span className="ta-upload__error">{pictureError}</span>}
                <input
                  ref={pictureInput}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  hidden
                  onChange={(e) => {
                    void pickPicture(e.target.files?.[0])
                    e.target.value = ''
                  }}
                />
              </div>
              <div className="ta-identity__fields">
                <Field label="Name" htmlFor="ta-name">
                  <Input id="ta-name" value={name} maxLength={120} onChange={(e) => setNameEdit(e.target.value)} />
                </Field>
                <div className="tma-field">
                  <label className="ta-count" htmlFor="ta-desc">
                    <span>One-line description</span>
                    <span className="ta-count__n">
                      {description.length}/{DESC_MAX}
                    </span>
                  </label>
                  <Input id="ta-desc" value={description} onChange={(e) => setDescription(e.target.value.slice(0, DESC_MAX))} />
                </div>
              </div>
            </div>
          </Card>

          <GithubSourceCard gh={gh} />

          <ModelCard models={models} modelId={model?.id ?? null} releaseId={release?.id ?? null} onModel={(id) => { setModelSel(id); setReleaseSel(null) }} onRelease={setReleaseSel} />

          <Card className="ta-card ta-card--tight">
            <span className="tma-label">Visibility</span>
            <div className="ta-pair ta-pair--even" role="radiogroup" aria-label="Visibility" style={{ gap: 12 }}>
              <RadioCard checked={visibility === 'private'} onSelect={() => setVisibility('private')} title="Private" description="Only you and people you share evidence with." />
              <RadioCard checked={visibility === 'listed'} onSelect={() => setVisibility('listed')} title="Listed" description="Appears in Agents after a verified evaluation." />
            </div>
          </Card>

          <div className="ta-actions">
            {saveError && (
              <span className="ta-error" role="alert" data-testid="save-error">
                {saveError}
              </span>
            )}
            <div className="ta-actions__row">
              <Button variant="secondary" onClick={() => navigate('/agents')}>
                Cancel
              </Button>
              <Button variant="primary" disabled={!canContinue} onClick={submit} data-testid="continue-to-tasks">
                {saving ? 'Saving…' : 'Continue to tasks'}
              </Button>
            </div>
          </div>
        </div>

        <div className="ta-col">
          <Card className="ta-access">
            <div className="tma-card__header">
              <span className="tma-card__title">What we access</span>
            </div>
            <KeyValue
              rows={[
                { key: 'Read', value: 'Selected repo, pinned commit' },
                { key: 'Run', value: 'Isolated sandbox' },
                { key: 'Stored', value: 'Artifact, digest, test results' },
                { key: 'Never shown', value: 'Your source, to buyers or anyone' },
              ]}
            />
          </Card>
          <AgentFilesPanel validation={gh.validation} path={cleanAgentPath(gh.agentPath)} />
          {/* U37: right column, beside the Source card: the left column (and the 02 design diff) does not move. */}
          <SampleRepoNotice gh={gh} kind="agent" />
        </div>
      </div>
    </main>
  )
}
