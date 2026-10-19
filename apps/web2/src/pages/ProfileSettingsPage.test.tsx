import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SessionProvider } from '../auth/session'
import { saveSession } from '../auth/sessionStorage'
import { ProfileSettingsPage } from './ProfileSettingsPage'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const USER = { id: 'dfl:11111111-2222-4333-8444-555555555555', email: 'profile@example.com' }
const AVATAR = 'https://storage.test/avatars/saved.webp'
let profile: Record<string, unknown>
let root: Root | undefined
let container: HTMLDivElement
let failUpload: boolean
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)) })

beforeEach(() => {
  profile = { wallet: USER.id, username: 'profile_test', displayName: 'Before', bio: '', avatarUrl: null, initials: 'PT' }
  failUpload = false
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname
    if (path === '/me/avatar') {
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer profile-test-session')
      expect(init?.body).toBeInstanceOf(FormData)
      if (failUpload) return new Response('<!doctype html><title>Error</title>Internal Server Error', { status: 500 })
      profile = { ...profile, avatarUrl: AVATAR }
      return json(profile, 201)
    }
    if (path === '/me') {
      if (init?.method === 'PATCH') profile = { ...profile, ...JSON.parse(init.body as string) }
      return json(profile)
    }
    if (path === '/github/installations') return json({ installations: [] })
    if (path === '/github/repos') return json({ repos: [] })
    if (path === '/github/install-url') return json({ url: null })
    if (path === '/agents') return json({ agents: [] })
    throw new Error(`unexpected endpoint: ${path}`)
  }))
  // jsdom has no image decoder or canvas encoder. Keep the real crop component and API client.
  const OriginalImage = Image
  vi.stubGlobal('Image', function () {
    const image = new OriginalImage()
    Object.defineProperties(image, { naturalWidth: { value: 512 }, naturalHeight: { value: 256 }, src: {
      get: () => 'blob:chosen-photo',
      set: () => setTimeout(() => image.onload?.(new Event('load')), 0),
    } })
    return image
  })
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL() { return 'blob:chosen-photo' }
    static revokeObjectURL() {}
  })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D)
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => callback(new Blob(['cropped-photo'], { type: 'image/png' })))
  saveSession({ token: 'profile-test-session', user: USER })
})

afterEach(() => {
  act(() => root?.unmount())
  root = undefined
  document.body.innerHTML = ''
  localStorage.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function mount() {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(<MemoryRouter><SessionProvider><ProfileSettingsPage /></SessionProvider></MemoryRouter>))
  await flush()
}

function change(input: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

async function pickAndZoom() {
  const file = container.querySelector<HTMLInputElement>('[data-testid="avatar-file"]')!
  Object.defineProperty(file, 'files', { value: [new File(['photo'], 'photo.png', { type: 'image/png' })] })
  act(() => file.dispatchEvent(new Event('change', { bubbles: true })))
  await flush()
  change(container.querySelector<HTMLInputElement>('[aria-label="Zoom"]')!, '1.5')
  expect(container.querySelector<HTMLInputElement>('[aria-label="Zoom"]')!.value).toBe('1.5')
  change(container.querySelector<HTMLInputElement>('[data-testid="display-name-input"]')!, 'After')
}

it('Save profile stores the selected crop with identity changes and reload shows both', async () => {
  await mount()
  await pickAndZoom()
  act(() => container.querySelector<HTMLButtonElement>('[data-testid="profile-save"]')!.click())
  await flush()
  expect(container.querySelector('[data-testid="profile-saved"]')?.textContent).toContain('Saved.')
  expect(profile).toMatchObject({ displayName: 'After', avatarUrl: AVATAR })
  act(() => root!.unmount())
  container.remove()
  await mount()
  expect(container.querySelector<HTMLInputElement>('[data-testid="display-name-input"]')!.value).toBe('After')
  expect(container.querySelector('[data-testid="profile-preview"] img')?.getAttribute('src')).toBe(AVATAR)
})

it('an avatar failure stays visible after identity saves and retains the crop for retry', async () => {
  failUpload = true
  await mount()
  await pickAndZoom()
  act(() => container.querySelector<HTMLButtonElement>('[data-testid="profile-save"]')!.click())
  await flush()
  expect(profile.displayName).toBe('After')
  expect(container.querySelector('[data-testid="profile-error"]')?.textContent).toBe('Request failed with status 500. Try again.')
  expect(container.querySelector('[data-testid="profile-saved"]')).toBeNull()
  expect(container.querySelector('[aria-label="Zoom"]')).not.toBeNull()
  failUpload = false
  act(() => container.querySelector<HTMLButtonElement>('[data-testid="profile-save"]')!.click())
  await flush()
  expect(profile.avatarUrl).toBe(AVATAR)
  expect(container.querySelector('[data-testid="profile-saved"]')).not.toBeNull()
})
