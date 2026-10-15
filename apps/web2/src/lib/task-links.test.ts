import { expect, test } from 'vitest'
import { hasPublicPage, lookupTask, publicTaskHref } from './task-links'

const curated = { id: 'u-1', slug: 'stripe-idempotency', kind: 'itera', visibility: 'public', status: 'ready' }

test('a public ready catalog task links to /tasks/:slug', () => {
  expect(publicTaskHref(curated)).toBe('/tasks/stripe-idempotency')
})

test('private, draft, unready and user tasks have no public page', () => {
  expect(hasPublicPage({ ...curated, visibility: 'private' })).toBe(false)
  expect(hasPublicPage({ ...curated, visibility: 'draft' })).toBe(false)
  expect(hasPublicPage({ ...curated, status: 'validating' })).toBe(false)
  expect(hasPublicPage({ ...curated, kind: 'user' })).toBe(false)
  expect(hasPublicPage({ ...curated, slug: null })).toBe(false)
  expect(publicTaskHref({})).toBeNull()
})

test('lookupTask matches by id or slug', () => {
  const list = [curated, { id: 'u-2', slug: 'b', kind: 'user', visibility: 'private', status: 'ready' }]
  expect(lookupTask(list, { id: 'u-1' })?.slug).toBe('stripe-idempotency')
  expect(lookupTask(list, { slug: 'b' })?.id).toBe('u-2')
  expect(lookupTask(list, {})).toBeUndefined()
  expect(lookupTask(list, { id: 'nope', slug: null })).toBeUndefined()
})
