import { describe, expect, it } from 'vitest'
import { providerOf } from './model-provider'

describe('providerOf', () => {
  it('reads the OpenRouter id prefix first', () => {
    const cases = [
      ['anthropic/claude-sonnet-4.5', 'anthropic'],
      ['openai/gpt-5', 'openai'],
      ['google/gemini-3-pro', 'google'],
      ['qwen/qwen3-coder', 'qwen'],
      ['deepseek/deepseek-v4', 'deepseek'],
      ['z-ai/glm-4.6', 'zai'],
      ['moonshotai/kimi-k2', 'kimi'],
      ['x-ai/grok-4.6', 'xai'],
      ['meta-llama/llama-4-maverick', 'meta'],
      ['mistralai/mistral-large', 'mistral'],
    ]
    for (const [id, want] of cases) expect(providerOf({ id }), id).toBe(want)
  })

  it('falls back to provider name, then label, then generic', () => {
    expect(providerOf({ provider: 'Alibaba' })).toBe('qwen')
    expect(providerOf({ provider: 'xAI' })).toBe('xai')
    expect(providerOf({ label: 'Claude Fable 5.1' })).toBe('anthropic')
    expect(providerOf({ label: 'GPT-5.6 Sol' })).toBe('openai')
    expect(providerOf({ id: 'claude-sonnet-4-5-20250929' })).toBe('anthropic')
    expect(providerOf({ id: 'acme/unknown-1', label: 'Unknown 1' })).toBe('generic')
    expect(providerOf({})).toBe('generic')
  })
})
