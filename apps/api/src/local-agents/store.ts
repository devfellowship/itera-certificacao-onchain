/**
 * Local agents and custom models (plan 20261026-tma-local-runner-and-self-declared-results, §3, ADR-4,
 * ADR-5; task L4). Needs db/migrations/0021_self_declared_results.sql (agents.connector 'local',
 * agents.provider_key / route_key, public.user_models).
 *
 *   A custom model belongs to ONE principal (the tenant). It never enters public.models, GET /models,
 *   or another principal's GET /model-options. At most 50 per owner.
 *   A local agent has connector 'local', no repo and no files, and one empty agent version (an
 *   evaluation needs an agent_version_id). It cannot start a hosted evaluation (409 agent_is_local).
 */
import { createHash } from "node:crypto";
import { isProviderKey, isRouteKey } from "@itera/contracts/model-catalog";
import { modelLookup } from "../self-declared/store.js";

export const CUSTOM_MODELS_MAX = 50;
export const AGENT_NAME_MAX = 120;
export const AGENT_DESCRIPTION_MAX = 90;
export const HARNESS_MAX = 120;
export const LOCAL_AGENTS_MIGRATION = "0021_self_declared_results.sql";

/** The model id pattern of tma-local-result/1 and of user_models.id (0021). */
export const MODEL_ID_RE = /^[a-z0-9][a-z0-9.-]{0,31}(\/[a-z0-9][a-z0-9.-]{0,31})?\/[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
/** Free text with no newline and no quote mark (the SAFE pattern of tma-local-result/1). */
export const SAFE_TEXT_RE = /^[A-Za-z0-9 .,:;/()+\-_%$=&'#]*$/;

export class LocalAgentsError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface CustomModel {
  id: string;
  label: string;
  providerKey: string | null;
  providerLabel: string | null;
  routeKey: string;
  createdAt: string;
}

export interface CustomModelInput {
  id: string;
  label: string;
  providerKey: string | null;
  providerLabel: string | null;
  routeKey: string;
}

export interface LocalAgent {
  id: string;
  ownerWallet: string;
  name: string;
  slug: string | null;
  description: string | null;
  visibility: "private" | "listed";
  status: string;
  connector: "local";
  model: string;
  providerKey: string | null;
  routeKey: string | null;
  harness: string | null;
  requires: string[];
  latestVersion: { id: string; commitSha: string; fileCount: number; createdAt: string } | null;
  createdAt: string;
}

export interface LocalAgentInput {
  name: string;
  description: string | null;
  model: string;
  providerKey: string | null;
  routeKey: string;
  harness: string | null;
  visibility: "private" | "listed";
  requires: string[];
}

export type LocalAgentPatch = Partial<LocalAgentInput>;

/** A known model of GET /model-options: an enabled public.models row (OpenRouter id). */
export interface KnownModel {
  id: string;
  label: string;
}

export interface LocalAgentsStore {
  /** True when 0021 is applied (agents.provider_key, user_models). */
  schemaReady(): Promise<boolean>;
  listKnownModels(): Promise<KnownModel[]>;
  /** Any public.models row with this id (enabled or not). */
  catalogHas(id: string): Promise<boolean>;
  listCustomModels(owner: string): Promise<CustomModel[]>;
  /** 409 custom_model_exists, 409 custom_model_limit. */
  createCustomModel(owner: string, input: CustomModelInput, max: number): Promise<CustomModel>;
  /** 404 custom_model_not_found, 409 model_in_use. */
  deleteCustomModel(owner: string, id: string): Promise<void>;
  /** 409 agent_name_taken. */
  createLocalAgent(owner: string, input: LocalAgentInput): Promise<LocalAgent>;
  /** Null when the agent does not exist or is not a local agent. */
  getLocalAgent(id: string): Promise<LocalAgent | null>;
  listLocalAgents(owner: string): Promise<LocalAgent[]>;
  /** 409 agent_name_taken. */
  updateLocalAgent(id: string, patch: LocalAgentPatch): Promise<LocalAgent>;
}

/** agent_versions.commit_sha of the one empty version of a local agent (plan §3). */
export function localCommitSha(name: string): string {
  return `local-${createHash("sha256").update(name).digest("hex").slice(0, 40)}`;
}

/** The model ids that need no row anywhere: a non-OpenRouter route prefix (`ollama/<model>`, ...). */
export function isRoutePrefixedModel(id: string): boolean {
  return "known" in modelLookup(id);
}

/** The OpenRouter id to look up in public.models (`openrouter/<a>/<m>` → `<a>/<m>`). */
export function catalogIdOf(id: string): string {
  const l = modelLookup(id);
  return "catalogId" in l ? l.catalogId : id;
}

/** 400 unknown_provider / unknown_route on a key outside model-catalog/. */
export function checkProviderKey(key: unknown): string {
  if (!isProviderKey(key)) throw new LocalAgentsError(400, "unknown_provider", "provider_key is not a lab key of GET /model-options");
  return key;
}

export function checkRouteKey(key: unknown): string {
  if (!isRouteKey(key)) throw new LocalAgentsError(400, "unknown_route", "route_key is not a route key of GET /model-options");
  return key;
}

export function checkModelId(id: unknown): string {
  if (typeof id !== "string" || id.length > 128 || !MODEL_ID_RE.test(id)) {
    throw new LocalAgentsError(400, "invalid_model_id", "model_id must look like <author>/<model> or <route>/<author>/<model>");
  }
  return id;
}

export function checkSafeText(value: unknown, field: string, max: number, min = 0): string {
  if (typeof value !== "string") throw new LocalAgentsError(400, "invalid", `${field} must be a string`);
  const v = value.trim();
  if (v.length < min || v.length > max || !SAFE_TEXT_RE.test(v)) {
    throw new LocalAgentsError(400, "invalid", `${field} must be ${min}..${max} characters of letters, digits and simple punctuation`);
  }
  return v;
}
