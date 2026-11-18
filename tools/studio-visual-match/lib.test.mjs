// node --test tools/studio-visual-match/lib.test.mjs (offline: no browser, no network, no model)
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { PNG } from 'pngjs'
import { crop, extractJson, followLink, loadScreens, normalizeClaudeVerdict, pickScreens, scoreVerdict, sideBySide } from './lib.mjs'

const screens = loadScreens(readFileSync(new URL('./screens.json', import.meta.url), 'utf8'))

test('screens.json covers S1 to S13 with the two detail screens', () => {
  const ids = screens.map((s) => s.id)
  for (let n = 1; n <= 13; n++) assert.ok(ids.includes(`S${n}`), `S${n} missing`)
  assert.ok(ids.includes('S10a') && ids.includes('S11a'))
  assert.deepEqual(screens.find((s) => s.id === 'S13').viewport, [390, 844])
  assert.deepEqual(screens.find((s) => s.id === 'S1').viewport, [1440, 960])
})

test('loadScreens fails closed', () => {
  assert.throws(() => loadScreens({ screens: [] }))
  assert.throws(() => loadScreens({ screens: [{ id: 'S1', artboard: 'A.dc.html', route: '/agents', actions: [{ id: 'x' }] }] }), /studio route/)
  assert.throws(() => loadScreens({ screens: [{ id: 'S1', artboard: '../x.dc.html', route: '/studio', actions: [{ id: 'x' }] }] }), /artboard/)
  assert.throws(() => pickScreens(screens, ['S99']), /unknown screen/)
})

test('followLink takes the first matching href', () => {
  assert.equal(followLink(['/studio', '/studio/graders/a', '/studio/graders/b'], { link: '^/studio/graders/.' }), '/studio/graders/a')
  assert.equal(followLink(['/studio'], { link: '^/studio/traces/.' }), null)
})

test('crop and sideBySide keep the sizes', () => {
  const a = new PNG({ width: 100, height: 60 })
  const c = crop(a, [10, 20, 500, 500])
  assert.deepEqual([c.width, c.height], [90, 40])
  const p = sideBySide(c, new PNG({ width: 30, height: 70 }), 4)
  assert.deepEqual([p.width, p.height], [124, 70])
})

const s1 = screens.find((s) => s.id === 'S1')

test('normalizeClaudeVerdict fails closed on a partial answer', () => {
  const rep = normalizeClaudeVerdict({ function: { actions: [{ action_id: 'use_case_rows', status: 'present' }] }, aesthetic: { aspects: [{ aspect: 'color', status: 'matches' }] } }, s1)
  assert.equal(rep.verdict.function.function_parity, 'partial')
  assert.equal(rep.verdict.aesthetic.aesthetic_parity, 'broken')
  assert.equal(rep.verdict.overall_pass, false)
})

test('a full answer matches and scores 100', () => {
  const raw = { function: { actions: s1.actions.map((a) => ({ action_id: a.id, status: 'present' })) }, aesthetic: { aspects: ['components', 'color', 'typography', 'layout', 'spacing'].map((aspect) => ({ aspect, status: 'matches' })) } }
  const sc = scoreVerdict(normalizeClaudeVerdict(raw, s1))
  assert.equal(sc.match, true)
  assert.equal(sc.score, 100)
})

test('adapted keeps the match, one diverges breaks it', () => {
  const fn = { actions: s1.actions.map((a) => ({ action_id: a.id, status: 'equivalent' })) }
  const adapted = normalizeClaudeVerdict({ function: fn, aesthetic: { aspects: ['components', 'color', 'typography', 'layout', 'spacing'].map((aspect) => ({ aspect, status: 'adapted' })) } }, s1)
  assert.equal(scoreVerdict(adapted).match, true)
  assert.equal(scoreVerdict(adapted).aesthetic, 75)
  const broken = normalizeClaudeVerdict({ function: fn, aesthetic: { aspects: [{ aspect: 'layout', status: 'diverges' }, ...['components', 'color', 'typography', 'spacing'].map((aspect) => ({ aspect, status: 'matches' }))] } }, s1)
  assert.equal(scoreVerdict(broken).match, false)
})

test('scoreVerdict of an error report never matches', () => {
  assert.deepEqual(scoreVerdict({ error: 'quota' }).match, false)
  assert.equal(scoreVerdict({ error: 'quota' }).score, null)
})

test('extractJson reads the first object of a reply', () => {
  assert.deepEqual(extractJson('Here: {"a":{"b":"}"}} trailing'), { a: { b: '}' } })
  assert.equal(extractJson('no json'), null)
})
