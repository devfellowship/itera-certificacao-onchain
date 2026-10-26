import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import data from '@itera/contracts/model-catalog/labs.json'
import { FALLBACK_LAB, LABS, PROVIDER_NAME, labOf, providerOf } from './model-provider'

const here = dirname(fileURLToPath(import.meta.url))

describe('providerOf', () => {
  it('reads the OpenRouter id prefix first', () => {
    const cases = [
      ['anthropic/claude-sonnet-4.5', 'anthropic'],
      ['openai/gpt-5', 'openai'],
      ['~openai/gpt-5-mini', 'openai'],
      ['google/gemini-3-pro', 'google'],
      ['qwen/qwen3-coder', 'qwen'],
      ['deepseek/deepseek-v4', 'deepseek'],
      ['z-ai/glm-4.6', 'zai'],
      ['moonshotai/kimi-k2', 'kimi'],
      ['x-ai/grok-4.6', 'xai'],
      ['meta-llama/llama-4-maverick', 'meta'],
      ['mistralai/mistral-large', 'mistral'],
      ['nvidia/llama-3.3-nemotron-super-49b', 'nvidia'],
      ['minimax/minimax-m3', 'minimax'],
      ['cohere/command-a', 'cohere'],
      ['microsoft/phi-4', 'microsoft'],
      ['amazon/nova-pro-v1', 'amazon'],
      ['tencent/hunyuan-a13b', 'tencent'],
      ['bytedance-seed/seed-oss-36b', 'bytedance'],
      ['xiaomi/mimo-v2', 'xiaomi'],
    ]
    for (const [id, want] of cases) expect(providerOf({ id }), id).toBe(want)
  })

  it('maps every executor of the transcript-mining bake-off to its original lab', () => {
    const cases = [
      // z.ai
      ['zai/glm-5.3', 'zai'],
      ['glm-5.3-flash', 'zai'],
      ['glm-5.1', 'zai'],
      ['glm-4.7', 'zai'],
      // local on alien01 (ollama): the lab that made the weights, not the runtime
      ['ollama/gemma4:12b', 'google'],
      ['gemma4:26b', 'google'],
      ['ollama/qwen3.5:9b', 'qwen'],
      ['qwen3.6:35b', 'qwen'],
      ['ollama/gpt-oss:20b', 'openai'],
      ['ollama/ministral-3:14b', 'mistral'],
      ['ollama/glm-4.7-flash', 'zai'],
      // opencode go
      ['opencode-go/deepseek-v4-pro', 'deepseek'],
      ['opencode-go/qwen3.7-plus', 'qwen'],
      ['opencode-go/minimax-m3', 'minimax'],
      // codex and Claude
      ['codex/gpt-5.5', 'openai'],
      ['gpt-5.5-codex-mini', 'openai'],
      ['claude-haiku-4-5', 'anthropic'],
    ]
    for (const [id, want] of cases) expect(providerOf({ id }), id).toBe(want)
  })

  it('does not take a route prefix for a lab', () => {
    // "ollama" holds "llama", and "opencode-go" is a route: neither may decide the lab.
    expect(providerOf({ id: 'ollama/gemma4:12b' })).toBe('google')
    expect(providerOf({ id: 'ollama/llama3.1:8b' })).toBe('meta')
    expect(providerOf({ id: 'opencode-go/unknown-model' })).toBe('generic')
    expect(providerOf({ id: 'ollama/my-finetune:7b' })).toBe('generic')
  })

  it('falls back to provider name, then label, then generic', () => {
    expect(providerOf({ provider: 'Alibaba' })).toBe('qwen')
    expect(providerOf({ provider: 'xAI' })).toBe('xai')
    expect(providerOf({ provider: 'NVIDIA' })).toBe('nvidia')
    expect(providerOf({ label: 'Claude Fable 5.1' })).toBe('anthropic')
    expect(providerOf({ label: 'GPT-5.6 Sol' })).toBe('openai')
    expect(providerOf({ label: 'DeepSeek V4.1 Flash' })).toBe('deepseek')
    expect(providerOf({ id: 'claude-sonnet-4-5-20250929' })).toBe('anthropic')
    expect(providerOf({ id: 'acme/unknown-1', label: 'Unknown 1' })).toBe('generic')
    expect(providerOf({ id: null, provider: null, label: null })).toBe('generic')
    expect(providerOf({})).toBe('generic')
  })

  it('gives the unknown model the neutral fallback lab', () => {
    const lab = labOf({ id: 'acme/mystery-7b' })
    expect(lab).toEqual(FALLBACK_LAB)
    expect(lab.logo).toBe('generic.svg')
    expect(PROVIDER_NAME[lab.key]).toBe('Unknown lab')
  })
})

describe('model-catalog/labs.json', () => {
  it('has unique keys, a name, valid regex patterns and an OpenRouter author slug for every lab', () => {
    const keys = data.labs.map((l) => l.key)
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys).not.toContain(data.fallback.key)
    for (const l of data.labs) {
      expect(l.name.length, l.key).toBeGreaterThan(0)
      expect(l.openrouter.length, l.key).toBeGreaterThan(0)
      expect(l.patterns.length, l.key).toBeGreaterThan(0)
      for (const p of l.patterns) expect(() => new RegExp(p), `${l.key}: ${p}`).not.toThrow()
    }
    expect(LABS.map((l) => l.key)).toEqual(keys)
  })

  it('has a vendored SVG logo for every lab and the fallback, with no script or remote reference', () => {
    for (const l of [...data.labs, data.fallback]) {
      const file = join(here, 'model-logos', l.logo)
      expect(existsSync(file), `${l.key}: ${l.logo}`).toBe(true)
      const svg = readFileSync(file, 'utf8')
      expect(svg.trimStart().startsWith('<svg'), l.logo).toBe(true)
      expect(svg, l.logo).not.toMatch(/<script|on\w+=|<foreignObject|(href|src)="https?:/i)
    }
  })

  it('names the labs that Tainan listed (TG 23250)', () => {
    const names = LABS.map((l) => l.name).join(' | ')
    for (const n of ['Anthropic', 'OpenAI', 'Zhipu', 'Google', 'Alibaba', 'Mistral', 'DeepSeek', 'NVIDIA']) expect(names).toContain(n)
  })
})
