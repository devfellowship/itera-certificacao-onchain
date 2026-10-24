// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { ModelAvatar, ModelLabel } from './ModelAvatar'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let host: HTMLElement | undefined
afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = host = undefined
})
function render(node: React.ReactNode): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root!.render(node))
  return host
}

describe('ModelAvatar', () => {
  it('shows the lab logo, the lab key and the lab name of a local model', () => {
    const c = render(<ModelAvatar model="ollama/gemma4:12b" />)
    const tile = c.querySelector('.tma-model-avatar')!
    expect(tile.getAttribute('data-lab')).toBe('google')
    expect(tile.getAttribute('title')).toBe('Google')
    expect(tile.querySelector('img')!.getAttribute('src')).toMatch(/google/)
  })

  it('shows the neutral fallback logo for an unknown model', () => {
    const c = render(<ModelLabel model="acme/mystery-7b" />)
    const tile = c.querySelector('.tma-model-avatar')!
    expect(tile.getAttribute('data-lab')).toBe('generic')
    expect(tile.getAttribute('title')).toBe('Unknown lab')
    expect(tile.querySelector('img')!.getAttribute('src')).toMatch(/generic/)
    expect(c.textContent).toContain('acme/mystery-7b')
  })

  it('gives each new lab its own logo file', () => {
    for (const [model, file] of [
      ['nvidia/nemotron-nano-9b', 'nvidia'],
      ['minimax/minimax-m3', 'minimax'],
      ['ollama/ministral-3:14b', 'mistral'],
    ]) {
      const c = render(<ModelAvatar model={model} />)
      expect(c.querySelector('img')!.getAttribute('src'), model).toMatch(new RegExp(file))
      act(() => root?.unmount())
      host?.remove()
      root = host = undefined
    }
  })
})
