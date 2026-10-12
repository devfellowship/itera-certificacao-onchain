import assert from 'node:assert/strict'
import test from 'node:test'
import { hasPublicPage, lookupTask, publicTaskHref } from './task-links.ts'

const curated = { id: 'u-1', slug: 'stripe-idempotency', kind: 'itera', visibility: 'public', status: 'ready' }

test('a public ready catalog task links to /tasks/:slug', () => {
  assert.equal(publicTaskHref(curated), '/tasks/stripe-idempotency')
})

test('private, draft, unready and user tasks have no public page', () => {
  assert.equal(hasPublicPage({ ...curated, visibility: 'private' }), false)
  assert.equal(hasPublicPage({ ...curated, visibility: 'draft' }), false)
  assert.equal(hasPublicPage({ ...curated, status: 'validating' }), false)
  assert.equal(hasPublicPage({ ...curated, kind: 'user' }), false)
  assert.equal(hasPublicPage({ ...curated, slug: null }), false)
  assert.equal(publicTaskHref({}), null)
})

test('lookupTask matches by id or slug', () => {
  const list = [curated, { id: 'u-2', slug: 'b', kind: 'user', visibility: 'private', status: 'ready' }]
  assert.equal(lookupTask(list, { id: 'u-1' })?.slug, 'stripe-idempotency')
  assert.equal(lookupTask(list, { slug: 'b' })?.id, 'u-2')
  assert.equal(lookupTask(list, {}), undefined)
  assert.equal(lookupTask(list, { id: 'nope', slug: null }), undefined)
})
