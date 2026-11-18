/**
 * "Melhorias" (in-app improvement requests) for TestMyAgent web2: the service client.
 *
 * Plan 20261103-in-app-improvements-melhorias. web2 has no Tailwind and no supabase-js, so (like the board)
 * this is a small local adapter with the same contract as `createImprovementsClient` of
 * `@devfellowship/components`:
 *   - screenshots: `POST {supabase}/functions/v1/upload-file`, `visibility=members`;
 *   - submit:      `POST {service}/v1/requests`;
 *   - mine:        `GET  {service}/v1/requests?mine=1`.
 * Every call carries the user's DFL JWT (`auth/dflToken.ts`), never a service key. The service checks
 * `iam.is_superadmin()` as the caller and answers 403 otherwise: hiding the launcher is cosmetic.
 */
import { DFL_SUPABASE_URL, IMPROVEMENTS_API_URL, IMPROVEMENTS_APP_SLUG } from '../config'

export const IMPROVEMENT_MAX_CHARS = 8000
export const IMPROVEMENT_MAX_IMAGES = 3
export const IMPROVEMENT_MEDIA_HOST = 'media.devfellowship.com'

const TARGET_MAX_BYTES = 300 * 1024
const PNG_KEEP_UNDER = 500 * 1024

export interface ImprovementRequestPayload {
  app_slug: string
  text: string
  image_urls: string[]
  context: { route: string; viewport: { width: number; height: number }; build_sha?: string; submitted_at: string }
}
export interface ImprovementSubmitResult {
  request_id?: string
  thread_id?: string
  task_id?: string
  thread_url?: string
}
export interface ImprovementRequestSummary {
  thread_id: string
  subject: string
  thread_status: string
  created_at: string
  closed_at: string | null
  task: { id: string; identifier: string | null; status: string } | null
  app_slug: string | null
  result_url: string | null
}

/** The first problem of a draft, or null when it can be sent. */
export function draftError(text: string, imageUrls: string[]): string | null {
  const trimmed = text.trim()
  if (!trimmed) return 'Descreva a melhoria.'
  if (trimmed.length > IMPROVEMENT_MAX_CHARS) return `Máximo de ${IMPROVEMENT_MAX_CHARS} caracteres.`
  if (imageUrls.length > IMPROVEMENT_MAX_IMAGES) return `Máximo de ${IMPROVEMENT_MAX_IMAGES} imagens.`
  if (imageUrls.some((url) => !isAllowedMediaUrl(url))) return 'Imagem fora do media da DFL.'
  return null
}

/** True only for an https URL on media.devfellowship.com. */
export function isAllowedMediaUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && parsed.hostname === IMPROVEMENT_MEDIA_HOST
  } catch {
    return false
  }
}

/** Only an http(s) URL becomes a link (never a `javascript:` from a stored value). */
export function safeHttpUrl(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : null
  } catch {
    return null
  }
}

/** The request payload, with the page context (route, viewport). */
export function buildPayload(
  text: string,
  imageUrls: string[],
  win: { location: { pathname: string; search: string }; innerWidth: number; innerHeight: number },
  now: Date = new Date(),
): ImprovementRequestPayload {
  return {
    app_slug: IMPROVEMENTS_APP_SLUG,
    text: text.trim(),
    image_urls: imageUrls,
    context: {
      route: `${win.location.pathname}${win.location.search}`,
      viewport: { width: win.innerWidth, height: win.innerHeight },
      submitted_at: now.toISOString(),
    },
  }
}

/** The image files of a paste: every `image/*` item of kind `file`, else `files`. */
export function pastedImages(data: Pick<DataTransfer, 'items' | 'files'> | null | undefined): File[] {
  if (!data) return []
  const out: File[] = []
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== 'file' || !item.type.startsWith('image/')) continue
    const file = item.getAsFile()
    if (file) out.push(file)
  }
  if (out.length === 0) for (const file of Array.from(data.files ?? [])) if (file.type.startsWith('image/')) out.push(file)
  return out
}

const STATUS_LABELS: Record<string, string> = {
  open: 'aberto',
  closed: 'fechado',
  backlog: 'backlog',
  todo: 'a fazer',
  in_progress: 'em andamento',
  in_review: 'em revisão',
  blocked: 'bloqueada',
  done: 'concluída',
  cancelled: 'cancelada',
  canceled: 'cancelada',
}
export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status
}

/** Compress a screenshot toward ~300 KB (JPEG quality sweep, scales 1 to 0.5). Small files pass untouched. */
export async function compressImage(file: File): Promise<File> {
  if (file.size <= TARGET_MAX_BYTES) return file
  if (file.type === 'image/png' && file.size <= PNG_KEEP_UNDER) return file
  const bitmap = await createImageBitmap(file)
  const name = `${file.name.replace(/\.[^.]*$/, '') || 'imagem'}.jpg`
  let last: Blob | null = null
  for (const scale of [1, 0.8, 0.6, 0.5]) {
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bitmap.width * scale))
    canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    const context = canvas.getContext('2d')
    if (!context) break
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    for (let quality = 0.9; quality >= 0.3 - 1e-9; quality -= 0.1) {
      last = await new Promise<Blob | null>((done) => canvas.toBlob(done, 'image/jpeg', Number(quality.toFixed(2))))
      if (last && last.size <= TARGET_MAX_BYTES) return new File([last], name, { type: 'image/jpeg' })
    }
  }
  bitmap.close?.()
  if (!last) throw new Error('Falha ao comprimir imagem')
  return new File([last], name, { type: 'image/jpeg' })
}

async function errorMessage(response: Response, fallback: string) {
  try {
    const body = (await response.json()) as { error?: unknown; message?: unknown }
    if (typeof body?.error === 'string' && body.error) return body.error
    if (typeof body?.message === 'string' && body.message) return body.message
  } catch {
    /* a body that is not JSON keeps the fallback */
  }
  return fallback
}

/** Thrown when the stored DFL token is missing or expired: the launcher must re-federate. */
export class DflTokenMissingError extends Error {
  constructor() {
    super('Sessão DFL expirada. Entre de novo.')
  }
}

export interface ImprovementsClient {
  /** `GET /v1/requests?mine=1`: 200 for a superadmin, 403 for anyone else. Any other answer is false. */
  isSuperadmin(): Promise<boolean>
  uploadImage(file: File): Promise<string>
  submit(payload: ImprovementRequestPayload): Promise<ImprovementSubmitResult>
  listMine(): Promise<ImprovementRequestSummary[]>
}

export function createImprovementsClient({
  getToken,
  fetchImpl = (input, init) => globalThis.fetch(input, init),
  serviceUrl = IMPROVEMENTS_API_URL,
  supabaseUrl = DFL_SUPABASE_URL,
}: {
  /** The user's DFL JWT, or null when there is none (or it expired). */
  getToken: () => string | null
  fetchImpl?: typeof fetch
  serviceUrl?: string
  supabaseUrl?: string
}): ImprovementsClient {
  const base = serviceUrl.replace(/\/+$/, '')
  const project = supabaseUrl.replace(/\/+$/, '')
  const authed = (url: string, init: RequestInit = {}) => {
    const token = getToken()
    if (!token) throw new DflTokenMissingError()
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${token}`)
    return fetchImpl(url, { ...init, headers })
  }
  return {
    async isSuperadmin() {
      try {
        const response = await authed(`${base}/v1/requests?mine=1&limit=1`)
        await response.body?.cancel().catch(() => undefined)
        return response.status === 200
      } catch {
        return false
      }
    },
    async uploadImage(file) {
      const compressed = await compressImage(file)
      const form = new FormData()
      form.append('file', compressed)
      form.append('visibility', 'members')
      const response = await authed(`${project}/functions/v1/upload-file`, { method: 'POST', body: form })
      if (!response.ok) throw new Error(await errorMessage(response, `Upload falhou (${response.status})`))
      const body = (await response.json().catch(() => null)) as { url?: unknown } | null
      if (typeof body?.url !== 'string' || !isAllowedMediaUrl(body.url)) throw new Error('Upload sem URL do media da DFL.')
      return body.url
    },
    async submit(payload) {
      const response = await authed(`${base}/v1/requests`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (response.status === 403) throw new Error('Apenas superadmins podem enviar melhorias.')
      if (!response.ok) throw new Error(await errorMessage(response, `Envio falhou (${response.status})`))
      return ((await response.json().catch(() => null)) ?? {}) as ImprovementSubmitResult
    },
    async listMine() {
      const response = await authed(`${base}/v1/requests?mine=1`)
      if (response.status === 403) throw new Error('Apenas superadmins podem ver melhorias.')
      if (!response.ok) throw new Error(await errorMessage(response, `Falha ao carregar melhorias (${response.status})`))
      const body = (await response.json().catch(() => null)) as { requests?: unknown } | null
      if (!Array.isArray(body?.requests)) throw new Error('Resposta inválida do serviço de melhorias.')
      return body.requests as ImprovementRequestSummary[]
    },
  }
}
