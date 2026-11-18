/**
 * Pure helpers of the studio visual-match check (plan 20261112-tma-c5-studio-area-web2, C5-VIS-MATCH).
 * No browser and no network here, so lib.test.mjs runs them offline.
 */
import { PNG } from 'pngjs'

export const DEFAULT_VIEWPORT = [1440, 960]
export const BG = [0x0a, 0x09, 0x08]

/** Reads screens.json and checks every entry. Throws on the first bad entry (fail closed). */
export function loadScreens(json) {
  const doc = typeof json === 'string' ? JSON.parse(json) : json
  if (!Array.isArray(doc?.screens) || doc.screens.length === 0) throw new Error('screens.json: no screens')
  const seen = new Set()
  for (const s of doc.screens) {
    if (!/^S\d+[a-z]?$/.test(s.id ?? '')) throw new Error(`screens.json: bad id ${JSON.stringify(s.id)}`)
    if (seen.has(s.id)) throw new Error(`screens.json: duplicate id ${s.id}`)
    seen.add(s.id)
    if (!/^[A-Za-z0-9]+\.dc\.html$/.test(s.artboard ?? '')) throw new Error(`screens.json: ${s.id} has a bad artboard`)
    const r = s.route
    const okRoute = typeof r === 'string' ? r.startsWith('/studio') : r && typeof r.from === 'string' && r.from.startsWith('/studio') && typeof r.link === 'string'
    if (!okRoute) throw new Error(`screens.json: ${s.id} needs a /studio route or {from, link}`)
    if (typeof r === 'object') new RegExp(r.link) // throws on a bad regex
    if (!Array.isArray(s.actions) || s.actions.length === 0) throw new Error(`screens.json: ${s.id} needs actions`)
    if (s.viewport && !(Array.isArray(s.viewport) && s.viewport.length === 2 && s.viewport.every((n) => Number.isInteger(n) && n > 0)))
      throw new Error(`screens.json: ${s.id} has a bad viewport`)
  }
  return doc.screens.map((s) => ({ ...s, viewport: s.viewport ?? DEFAULT_VIEWPORT }))
}

/** Picks the screens of --screen (ids, comma separated) or all. Unknown ids throw. */
export function pickScreens(screens, ids) {
  if (!ids || ids.length === 0) return screens
  return ids.map((id) => {
    const s = screens.find((x) => x.id === id)
    if (!s) throw new Error(`unknown screen ${id} (known: ${screens.map((x) => x.id).join(', ')})`)
    return s
  })
}

/** The first link (in page order) whose path matches the route rule. Hrefs are paths of the same origin. */
export function followLink(hrefs, rule) {
  const re = new RegExp(rule.link)
  return hrefs.find((h) => typeof h === 'string' && re.test(h)) ?? null
}

/** Copies the rectangle [x, y, w, h] of a PNG (clamped to the image). */
export function crop(png, [x, y, w, h]) {
  const x0 = Math.max(0, Math.min(png.width, Math.round(x)))
  const y0 = Math.max(0, Math.min(png.height, Math.round(y)))
  const cw = Math.max(1, Math.min(png.width - x0, Math.round(w)))
  const ch = Math.max(1, Math.min(png.height - y0, Math.round(h)))
  const out = new PNG({ width: cw, height: ch })
  PNG.bitblt(png, out, x0, y0, cw, ch, 0, 0)
  return out
}

function fill(png, rgb) {
  for (let i = 0; i < png.width * png.height; i++) png.data.set([...rgb, 255], i * 4)
}

export function padTo(png, w, h) {
  if (png.width === w && png.height === h) return png
  const out = new PNG({ width: w, height: h })
  fill(out, BG)
  PNG.bitblt(png, out, 0, 0, Math.min(png.width, w), Math.min(png.height, h), 0, 0)
  return out
}

/** Design at the left, live at the right, a gap between, both top aligned. */
export function sideBySide(a, b, gap = 24) {
  const out = new PNG({ width: a.width + gap + b.width, height: Math.max(a.height, b.height) })
  fill(out, [0x30, 0x2c, 0x28])
  PNG.bitblt(a, out, 0, 0, a.width, a.height, 0, 0)
  PNG.bitblt(b, out, 0, 0, b.width, b.height, a.width + gap, 0)
  return out
}

const ASPECT_POINTS = { matches: 1, adapted: 0.75, diverges: 0 }
const ACTION_POINTS = { present: 1, equivalent: 1, missing: 0 }

/**
 * Score of one judge verdict (vision-llm-judge --rubric-pair report), 0-100:
 * aesthetic = mean of its five aspects (matches 1, adapted 0.75, diverges 0); function = share of actions
 * present or equivalent; score = the mean of the two. match = the judge's overall_pass (function parity full,
 * aesthetic parity full or adapted). A report without a verdict scores null and never matches.
 */
export function scoreVerdict(report) {
  const v = report?.verdict
  if (!v || report.error) return { score: null, aesthetic: null, function: null, match: false, reason: report?.error ?? 'no verdict' }
  const pct = (xs, table) => (xs.length ? Math.round((xs.reduce((n, x) => n + (table[x] ?? 0), 0) / xs.length) * 100) : null)
  const aesthetic = v.aesthetic ? pct(v.aesthetic.aspects.map((a) => a.status), ASPECT_POINTS) : null
  const fn = v.function ? pct(v.function.actions.map((a) => a.status), ACTION_POINTS) : null
  const parts = [aesthetic, fn].filter((x) => x != null)
  const score = parts.length ? Math.round(parts.reduce((a, b) => a + b, 0) / parts.length) : null
  return {
    score,
    aesthetic,
    function: fn,
    match: v.overall_pass === true,
    aesthetic_parity: v.aesthetic?.aesthetic_parity ?? null,
    function_parity: v.function?.function_parity ?? null,
    diverges: (v.aesthetic?.aspects ?? []).filter((a) => a.status === 'diverges').map((a) => `${a.aspect}: ${a.rationale}`),
    missing: (v.function?.actions ?? []).filter((a) => a.status === 'missing').map((a) => `${a.action_id}: ${a.rationale}`),
  }
}

export const ASPECTS = ['components', 'color', 'typography', 'layout', 'spacing']

/** The rubric for the Claude CLI judge: the same two dimensions and statuses as vision-llm-judge --rubric-pair. */
export function claudeJudgePrompt(s, designPath, livePath) {
  const actions = s.actions.map((a) => `- ${a.id}: ${a.intent}`).join('\n')
  return `You judge the visual match of one screen. Use the Read tool on these two PNG files, then answer.
A (reference, the design artboard): ${designPath}
B (under audit, the live page): ${livePath}
Screen: ${s.title}. Both sides had their app chrome cut away (top bar, icon rail). A holds illustrative data, B holds real data: judge layout, components and style, never the numbers, names or row counts.

FUNCTION (loose): for each action, is it on B? "present", "equivalent" (same goal, other control) or "missing".
${actions}

AESTHETIC (loose): for each aspect (${ASPECTS.join(', ')}): "matches" (faithful to A), "adapted" (same design language, reflowed for other data), or "diverges" (a different visual treatment: other component family, other layout structure, other palette or type).

Reply with ONLY this JSON, no prose, no fences:
{"function":{"actions":[{"action_id":"<id>","status":"present|equivalent|missing","rationale":"<one sentence, A vs B>"}]},"aesthetic":{"aspects":[{"aspect":"<aspect>","status":"matches|adapted|diverges","rationale":"<one sentence, A vs B>"}]}}`
}

/** The first balanced {...} of a text, parsed; null when there is none. */
export function extractJson(text) {
  const t = String(text ?? '')
  for (let start = t.indexOf('{'); start !== -1; start = t.indexOf('{', start + 1)) {
    let depth = 0
    let inStr = false
    for (let i = start; i < t.length; i++) {
      const c = t[i]
      if (inStr) {
        if (c === '\\') i++
        else if (c === '"') inStr = false
      } else if (c === '"') inStr = true
      else if (c === '{') depth++
      else if (c === '}' && --depth === 0) {
        try {
          return JSON.parse(t.slice(start, i + 1))
        } catch {
          break
        }
      }
    }
  }
  return null
}

/**
 * Normalizes a Claude judge answer into the vision-llm-judge report shape. Fail closed: an action the answer leaves
 * out is "missing", an aspect it leaves out is "diverges", an unknown status takes the strictest value.
 */
export function normalizeClaudeVerdict(raw, s) {
  const fnIn = Array.isArray(raw?.function?.actions) ? raw.function.actions : []
  const actions = s.actions.map((a) => {
    const got = fnIn.find((x) => x?.action_id === a.id)
    const status = ['present', 'equivalent', 'missing'].includes(got?.status) ? got.status : 'missing'
    return { action_id: a.id, status, rationale: String(got?.rationale ?? 'not in the answer') }
  })
  const asIn = Array.isArray(raw?.aesthetic?.aspects) ? raw.aesthetic.aspects : []
  const aspects = ASPECTS.map((name) => {
    const got = asIn.find((x) => x?.aspect === name)
    const status = ['matches', 'adapted', 'diverges'].includes(got?.status) ? got.status : 'diverges'
    return { aspect: name, status, rationale: String(got?.rationale ?? 'not in the answer') }
  })
  const missing = actions.filter((a) => a.status === 'missing').length
  const diverge = aspects.filter((a) => a.status === 'diverges').length
  const function_parity = missing === 0 ? 'full' : missing === actions.length ? 'broken' : 'partial'
  const aesthetic_parity = diverge > 0 ? 'broken' : aspects.every((a) => a.status === 'matches') ? 'full' : 'adapted'
  return {
    mode: 'rubric_pair',
    backend: 'claude-cli',
    verdict: {
      function: { actions, missing_count: missing, function_parity },
      aesthetic: { aspects, divergence_count: diverge, aesthetic_parity },
      overall_pass: function_parity === 'full' && aesthetic_parity !== 'broken',
    },
  }
}
