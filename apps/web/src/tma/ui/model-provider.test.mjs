import assert from 'node:assert/strict'
import test from 'node:test'
import { providerOf } from './model-provider.ts'

test('providerOf reads the OpenRouter id prefix first', () => {
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
  for (const [id, want] of cases) assert.equal(providerOf({ id }), want, id)
})

test('providerOf falls back to provider name, then label, then generic', () => {
  assert.equal(providerOf({ provider: 'Alibaba' }), 'qwen')
  assert.equal(providerOf({ provider: 'xAI' }), 'xai')
  assert.equal(providerOf({ label: 'Claude Fable 5.1' }), 'anthropic')
  assert.equal(providerOf({ label: 'GPT-5.6 Sol' }), 'openai')
  assert.equal(providerOf({ id: 'claude-sonnet-4-5-20250929' }), 'anthropic')
  assert.equal(providerOf({ id: 'acme/unknown-1', label: 'Unknown 1' }), 'generic')
  assert.equal(providerOf({}), 'generic')
})
