/**
 * Edit profile — "Account / Profile" (U36, plan 20261012-itera-testmyagent-ui-refactor; design: Tainan TG 21099).
 * Data: GET/PATCH /me (username, display name, bio), POST/DELETE /me/avatar, GET /usernames/:name/available,
 * GET /github/installations + /github/repos (Connected card), GET /agents (preview row).
 * The picture is cropped to a square here and sent as a 256×256 PNG; the API re-encodes it
 * (256×256 WebP, no metadata). Linked from "Edit profile" in the account menu.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useSession } from '../auth/session'
import { api, ApiError } from '../lib/api'
import type { UsernameAvailability } from '../lib/api'
import { AgentAvatar, Avatar, Breadcrumb, Button, Card, Input, middle } from '../tma/ui'
import { AvatarCropper, renderCrop, type CropState } from './profile-settings/AvatarCropper'
import './profile-settings/profile-settings.css'

const USERNAME_RE = /^[a-z0-9_-]{3,30}$/
const TYPES = ['image/png', 'image/jpeg', 'image/webp']
const MAX_BYTES = 2 * 1024 * 1024
const BIO_MAX = 80
const PUBLIC_HOST = 'testmyagent.com'

function usernameProblem(u: string): string | null {
  if (u === '') return null
  if (u.length < 3) return 'At least 3 characters.'
  if (u.length > 30) return 'At most 30 characters.'
  if (!USERNAME_RE.test(u)) return 'Use only a–z, 0–9, _ and -.'
  return null
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('This file is not a readable image.'))
    img.src = URL.createObjectURL(file)
  })
}

const plural = (n: number, w: string) => `${w}${n === 1 ? '' : 's'}`

export function ProfileSettingsPage() {
  const session = useSession()
  const me = session.me
  const [username, setUsername] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [bio, setBio] = useState('')
  const [crop, setCrop] = useState<CropState | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [removePic, setRemovePic] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [avail, setAvail] = useState<UsernameAvailability | null>(null)
  const [github, setGithub] = useState<{ account: string | null; repos: number } | null>(null)
  const [installUrl, setInstallUrl] = useState<string | null>(null)
  const [agentName, setAgentName] = useState<{ id: string; name: string } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const original = useMemo(
    () => ({ username: me?.username ?? me?.handle ?? '', displayName: me?.displayName ?? '', bio: me?.bio ?? '' }),
    [me?.username, me?.handle, me?.displayName, me?.bio],
  )
  const reset = () => {
    setUsername(original.username)
    setDisplayName(original.displayName)
    setBio(original.bio)
    setCrop(null)
    setRemovePic(false)
    setError(null)
  }
  // Fill the form when the profile arrives or changes on the server.
  useEffect(reset, [original]) // eslint-disable-line react-hooks/exhaustive-deps

  // Connected card + preview row: best effort, the form works without them.
  useEffect(() => {
    let live = true
    Promise.all([api.githubInstallations().catch(() => null), api.githubRepos().catch(() => null)]).then(([inst, repos]) => {
      if (!live || !inst) return
      const first = inst.installations[0]
      setGithub(first ? { account: first.accountLogin, repos: repos?.repos.length ?? 0 } : null)
    })
    api.githubInstallUrl().then((r) => live && setInstallUrl(r.url)).catch(() => undefined)
    api
      .agents()
      .then((r) => live && r.agents[0] && setAgentName({ id: r.agents[0].id, name: r.agents[0].name }))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [])

  // Live preview of the crop, as the 256 px file the API receives.
  useEffect(() => {
    if (!crop) {
      setPreview(null)
      return
    }
    let live = true
    let url: string | null = null
    const t = window.setTimeout(() => {
      renderCrop(crop)
        .then((b) => {
          if (!live) return
          url = URL.createObjectURL(b)
          setPreview(url)
        })
        .catch(() => undefined)
    }, 60)
    return () => {
      live = false
      window.clearTimeout(t)
      if (url) URL.revokeObjectURL(url)
    }
  }, [crop])

  const uname = username.trim().toLowerCase()
  const problem = usernameProblem(uname)

  // Live availability (debounced). The caller's own username is available.
  useEffect(() => {
    setAvail(null)
    if (!uname || problem || uname === original.username) return
    const t = window.setTimeout(() => {
      api
        .usernameAvailable(uname)
        .then(setAvail)
        .catch(() => undefined)
    }, 300)
    return () => window.clearTimeout(t)
  }, [uname, problem, original.username])

  const taken = avail && avail.username === uname && !avail.available
  const dirty =
    !!me &&
    (uname !== original.username || displayName.trim() !== original.displayName || bio.trim() !== original.bio || crop !== null || removePic)

  async function pick(file: File | undefined) {
    setError(null)
    setSaved(false)
    if (!file) return
    if (!TYPES.includes(file.type)) {
      setError('The picture must be PNG, JPG or WebP.')
      return
    }
    if (file.size > MAX_BYTES) {
      setError('The picture must be 2 MB or smaller.')
      return
    }
    try {
      const img = await loadImage(file)
      setRemovePic(false)
      setCrop({ img, zoom: 1, x: 0, y: 0 })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'This file is not a readable image.')
    }
  }

  async function save() {
    if (!me || problem || taken || saving || !dirty) return
    setSaving(true)
    setError(null)
    setSaved(false)
    try {
      let next = me
      if (uname !== original.username || displayName.trim() !== original.displayName || bio.trim() !== original.bio) {
        next = { ...next, ...(await api.patchMe({ username: uname || null, displayName: displayName.trim() || null, bio: bio.trim() || null })) }
      }
      if (crop) next = { ...next, ...(await api.uploadAvatar(await renderCrop(crop), 'avatar.png')) }
      else if (removePic) next = { ...next, ...(await api.deleteAvatar()) }
      setCrop(null)
      setRemovePic(false)
      session.setMe(next)
      setSaved(true)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not save the profile. Try again.')
    } finally {
      setSaving(false)
    }
  }

  if (!me) return null
  const shownPic = removePic ? null : preview ?? me.avatarUrl ?? null
  const shownName = displayName.trim() || (uname ? `@${uname}` : middle(me.wallet, 4, 4))
  const stats = me.stats

  return (
    <main className="tma-page tma-page--flow tps" data-testid="profile-settings-page">
      <div className="tps-head">
        <Breadcrumb items={[{ label: 'Account' }, { label: 'Profile' }]} />
        <h1 className="tma-h1">Profile</h1>
        <p className="tps-sub">Shown next to your agents, tasks and evaluation profiles.</p>
      </div>

      <div className="tps-grid">
        <div className="tps-col">
          <Card className="tps-card">
            <span className="tma-label">Profile picture</span>
            <div className="tps-picture">
              {crop ? <AvatarCropper crop={crop} onChange={setCrop} /> : <Avatar size={80} src={shownPic} initials={me.initials} shape="circle" />}
              <div className="tps-picture__side">
                <div className="tps-actions">
                  <Button variant="inverse" size={36} onClick={() => fileRef.current?.click()} disabled={saving} data-testid="avatar-choose">
                    Upload photo
                  </Button>
                  <Button
                    variant="secondary"
                    size={36}
                    onClick={() => (crop ? setCrop(null) : setRemovePic(true))}
                    disabled={saving || (!crop && !shownPic)}
                    data-testid="avatar-remove"
                  >
                    Remove
                  </Button>
                </div>
                <span className="tps-hint">PNG, JPG or WebP. Square, at least 256 × 256. Max 2 MB.</span>
                {crop && <span className="tps-hint">Drag to move, use the slider to zoom. The picture is saved with the profile.</span>}
                <input
                  ref={fileRef}
                  type="file"
                  accept={TYPES.join(',')}
                  hidden
                  data-testid="avatar-file"
                  onChange={(e) => {
                    void pick(e.target.files?.[0])
                    e.target.value = ''
                  }}
                />
              </div>
            </div>
          </Card>

          <Card className="tps-card">
            <span className="tma-label">Identity</span>
            <div className="tma-field">
              <label className="tma-field__label" htmlFor="tps-display">
                Display name
              </label>
              <Input id="tps-display" value={displayName} maxLength={60} onChange={(e) => setDisplayName(e.target.value)} data-testid="display-name-input" />
            </div>
            <div className="tma-field">
              <label className="tma-field__label" htmlFor="tps-username">
                Username
              </label>
              <div className="tps-prefix">
                <span className="tps-prefix__host">{PUBLIC_HOST}/u/</span>
                <input
                  id="tps-username"
                  className="tps-prefix__input"
                  value={username}
                  maxLength={30}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => setUsername(e.target.value.toLowerCase())}
                  data-testid="username-input"
                />
              </div>
              {problem ? (
                <span className="tps-status tps-status--bad">{problem}</span>
              ) : taken ? (
                <span className="tps-status tps-status--bad" data-testid="username-status">
                  <span className="tps-dot" /> {avail?.reason === 'reserved' ? 'Reserved' : 'Taken'}
                </span>
              ) : uname && (uname === original.username || (avail && avail.username === uname)) ? (
                <span className="tps-status tps-status--ok" data-testid="username-status">
                  <span className="tps-dot" /> Available
                </span>
              ) : (
                <span className="tps-status">3–30 characters: a–z, 0–9, _ and -.</span>
              )}
            </div>
            <div className="tma-field">
              <label className="tps-count" htmlFor="tps-bio">
                <span>
                  Bio <span className="tma-subtle">· optional</span>
                </span>
                <span className="tps-count__n">
                  {bio.length}/{BIO_MAX}
                </span>
              </label>
              <Input id="tps-bio" value={bio} onChange={(e) => setBio(e.target.value.slice(0, BIO_MAX))} data-testid="bio-input" />
            </div>
          </Card>

          <Card className="tps-card tps-card--rows">
            <span className="tma-label tps-rows__title">Connected</span>
            <div className="tps-row">
              <span className="tma-label">GitHub</span>
              <span className="tps-row__v">
                {github ? (
                  <>
                    {github.account ?? 'GitHub App'} <span className="tma-muted">· {github.repos} {plural(github.repos, 'repo')}</span>
                  </>
                ) : (
                  <span className="tma-muted">Not connected</span>
                )}
              </span>
              {installUrl && (
                <a className="tps-row__link" href={installUrl} target="_blank" rel="noreferrer">
                  {github ? 'Manage ↗' : 'Connect ↗'}
                </a>
              )}
            </div>
            <div className="tps-row">
              <span className="tma-label">Wallet</span>
              <span className="tps-row__v">
                <span className="tma-account__live" /> <span className="tps-mono">{middle(me.wallet, 7, 5)}</span>{' '}
                <span className="tma-muted">· {session.walletName ?? 'Wallet'}</span>
              </span>
              <button type="button" className="tps-row__plain" onClick={() => void session.signOut()}>
                Disconnect
              </button>
            </div>
          </Card>

          <div className="tps-footer">
            {error && (
              <span className="tps-error" role="alert" data-testid="profile-error">
                {error}
              </span>
            )}
            {saved && !error && !dirty && (
              <span className="tps-saved" role="status" data-testid="profile-saved">
                Saved.
              </span>
            )}
            <Button variant="secondary-dark" size={40} onClick={reset} disabled={!dirty || saving}>
              Discard
            </Button>
            <Button variant="primary" size={40} onClick={save} disabled={!dirty || !!problem || !!taken || saving} data-testid="profile-save">
              {saving ? 'Saving…' : 'Save profile'}
            </Button>
          </div>
        </div>

        <aside className="tps-col tps-col--preview" aria-label="Preview">
          <span className="tma-label">Preview</span>
          <Card className="tps-pcard" data-testid="profile-preview">
            <Avatar size={72} src={shownPic} initials={me.initials} shape="circle" />
            <span className="tps-pcard__name">{shownName}</span>
            {uname && <span className="tps-pcard__handle">@{uname}</span>}
            {bio.trim() && <span className="tps-pcard__bio">{bio.trim()}</span>}
            {stats && (
              <span className="tps-pcard__stats">
                <span>
                  <b>{stats.agents}</b> {plural(stats.agents, 'agent')}
                </span>
                <span>
                  <b>{stats.tasks}</b> {plural(stats.tasks, 'task')}
                </span>
              </span>
            )}
          </Card>
          <Card className="tps-lrow">
            <AgentAvatar size={44} id={agentName?.id ?? me.wallet} name={agentName?.name ?? 'Your agent'} author={{ name: shownName, avatarUrl: shownPic }} />
            <span className="tps-lrow__text">
              <span className="tps-lrow__name">{agentName?.name ?? 'Your agent'}</span>
              <span className="tps-lrow__by">
                by <b>{shownName}</b> · today
              </span>
            </span>
          </Card>
          <span className="tps-hint">How you appear in agent and task lists.</span>
        </aside>
      </div>
    </main>
  )
}
