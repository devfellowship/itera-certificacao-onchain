/** In-memory LocalAgentsStore for router tests: the same rules as store.pg.ts. */
import { randomUUID } from "node:crypto";
import { SchemaNotReadyError } from "../domain/runs-store.js";
import {
  LOCAL_AGENTS_MIGRATION,
  LocalAgentsError,
  localCommitSha,
  type CustomModel,
  type CustomModelInput,
  type KnownModel,
  type LocalAgent,
  type LocalAgentInput,
  type LocalAgentPatch,
  type LocalAgentsStore,
} from "./store.js";

export class FakeLocalAgentsStore implements LocalAgentsStore {
  ready = true;
  /** public.models: id → enabled. */
  models = new Map<string, { label: string; enabled: boolean }>();
  custom = new Map<string, CustomModel[]>();
  agents = new Map<string, LocalAgent>();
  /** Models used by agents that are not local (GitHub agents), by owner. */
  otherAgentModels: Array<{ owner: string; model: string }> = [];

  private need() {
    if (!this.ready) throw new SchemaNotReadyError(LOCAL_AGENTS_MIGRATION);
  }

  async schemaReady() {
    return this.ready;
  }
  async listKnownModels(): Promise<KnownModel[]> {
    return [...this.models].filter(([, m]) => m.enabled).map(([id, m]) => ({ id, label: m.label }));
  }
  async catalogHas(id: string) {
    return this.models.has(id);
  }
  async listCustomModels(owner: string) {
    return this.ready ? [...(this.custom.get(owner) ?? [])] : [];
  }
  async createCustomModel(owner: string, m: CustomModelInput, max: number) {
    this.need();
    const list = this.custom.get(owner) ?? [];
    if (list.some((x) => x.id === m.id)) throw new LocalAgentsError(409, "custom_model_exists", `you have a custom model ${m.id}`);
    if (list.length >= max) throw new LocalAgentsError(409, "custom_model_limit", `at most ${max} custom models`);
    const row: CustomModel = { ...m, createdAt: new Date().toISOString() };
    this.custom.set(owner, [...list, row]);
    return row;
  }
  async deleteCustomModel(owner: string, id: string) {
    this.need();
    const list = this.custom.get(owner) ?? [];
    if (!list.some((x) => x.id === id)) throw new LocalAgentsError(404, "custom_model_not_found", "custom model not found");
    const used = [...this.agents.values()].some((a) => a.ownerWallet === owner && a.model === id) || this.otherAgentModels.some((a) => a.owner === owner && a.model === id);
    if (used) throw new LocalAgentsError(409, "model_in_use", "an agent of yours uses this model: change its model first");
    this.custom.set(owner, list.filter((x) => x.id !== id));
  }
  private nameTaken(owner: string, name: string, except?: string) {
    if ([...this.agents.values()].some((a) => a.ownerWallet === owner && a.name === name && a.id !== except)) {
      throw new LocalAgentsError(409, "agent_name_taken", "you have an agent with this name");
    }
  }
  async createLocalAgent(owner: string, input: LocalAgentInput) {
    this.need();
    this.nameTaken(owner, input.name);
    const id = randomUUID();
    const now = new Date().toISOString();
    const agent: LocalAgent = {
      id, ownerWallet: owner, name: input.name, slug: input.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), description: input.description,
      visibility: input.visibility, status: "active", connector: "local", model: input.model, providerKey: input.providerKey, routeKey: input.routeKey,
      harness: input.harness, requires: input.requires, latestVersion: { id: randomUUID(), commitSha: localCommitSha(input.name), fileCount: 0, createdAt: now }, createdAt: now,
    };
    this.agents.set(id, agent);
    return { ...agent };
  }
  async getLocalAgent(id: string) {
    const a = this.agents.get(id);
    return a ? { ...a } : null;
  }
  async listLocalAgents(owner: string) {
    return [...this.agents.values()].filter((a) => a.ownerWallet === owner);
  }
  async updateLocalAgent(id: string, p: LocalAgentPatch) {
    this.need();
    const a = this.agents.get(id)!;
    if (p.name !== undefined) this.nameTaken(a.ownerWallet, p.name, id);
    const next = { ...a, ...Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined)) } as LocalAgent;
    this.agents.set(id, next);
    return { ...next };
  }
}
