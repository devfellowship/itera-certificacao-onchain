// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, expect, it, vi } from 'vitest'
import { TaskEditorPage } from './pages/TaskEditorPage'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let cleanup: (() => void) | undefined

afterEach(() => { cleanup?.(); document.body.innerHTML = ''; vi.restoreAllMocks(); vi.unstubAllGlobals() })
it('reads an owned catalog pack without offering GitHub changes or validation', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url.includes('/tasks/pack') ? {
    task: { id: 'pack', kind: 'itera', source: 'curated', mine: true, name: 'Repository Research', description: 'Historical benchmark.', latestVersion: { version: 4, packId: 'dfl-fleet-research', packVersion: '4', fixtureDigest: 'abc' } },
  } : { tags: [], installations: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })))
  const div = document.createElement('div'); document.body.append(div)
  const root = createRoot(div); cleanup = () => act(() => root.unmount())
  await act(async () => { root.render(<MemoryRouter initialEntries={['/tasks/pack/edit']}><Routes><Route path="/tasks/:id/edit" element={<TaskEditorPage />} /></Routes></MemoryRouter>) })
  expect(div.textContent).toContain('Repository Research')
  expect(div.textContent).toContain('dfl-fleet-research@4')
  expect(div.textContent).toContain('Read-only benchmark task')
  expect(div.textContent).not.toContain('Task not found')
  expect(div.querySelector('button')).toBeNull()
})
