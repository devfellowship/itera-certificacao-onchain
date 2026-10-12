/**
 * OpenRouter models a GitHub agent may run on. Itera pays for the demo runs (plan open question
 * "who pays the model tokens"), so the list is short and cost-aware. All ids were checked against
 * https://openrouter.ai/api/v1/models on 2026-10-12 and all support tool calls.
 */
export const AGENT_MODELS = [
  { id: "anthropic/claude-haiku-4.5", label: "Claude Haiku 4.5" },
  { id: "anthropic/claude-sonnet-4.6", label: "Claude Sonnet 4.6" },
  { id: "qwen/qwen3-coder", label: "Qwen3 Coder 480B" },
  { id: "moonshotai/kimi-k2.7-code", label: "Kimi K2.7 Code" },
  { id: "deepseek/deepseek-v4.1-flash", label: "DeepSeek V4.1 Flash" },
] as const;

export const DEFAULT_AGENT_MODEL = AGENT_MODELS[0].id;

export function isAllowedModel(model: unknown): model is string {
  return typeof model === "string" && AGENT_MODELS.some((m) => m.id === model);
}
