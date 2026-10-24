import { describe, expect, it } from 'vitest'
import { DEFAULT_ROUTE, routeOf } from './model-route'

describe('routeOf', () => {
  it('names the route from the id prefix', () => {
    expect(routeOf('opencode-go/deepseek-v4-pro').name).toBe('opencode go')
    expect(routeOf('ollama/gemma4:12b').name).toBe('local Ollama')
    expect(routeOf('zai/glm-5.3').name).toBe('Z.ai API')
    expect(routeOf('codex/gpt-5.5-low').name).toBe('Codex CLI')
    expect(routeOf('claude-code/claude-haiku-4.5').name).toBe('Claude Code CLI')
    expect(routeOf('minimax/minimax-m3').name).toBe('MiniMax API')
    expect(routeOf('openrouter/anthropic/claude-haiku-4.5').name).toBe('OpenRouter')
  })
  it('keeps OpenRouter for OpenRouter author slugs and for unknown ids', () => {
    expect(routeOf('anthropic/claude-haiku-4.5')).toEqual(DEFAULT_ROUTE)
    expect(routeOf('z-ai/glm-4.6').name).toBe('OpenRouter')
    expect(routeOf('qwen/qwen3-coder').name).toBe('OpenRouter')
    expect(routeOf('gpt-5.5').name).toBe('OpenRouter')
    expect(routeOf(null).name).toBe('OpenRouter')
    expect(routeOf('').name).toBe('OpenRouter')
    expect(routeOf('constructor/x').name).toBe('OpenRouter')
  })
})
