import { describe, expect, it } from "vitest";
import { isSampleRepo, repoSourceOf, sampleInstallation, sampleReposFromEnv, SampleRepoError } from "./sample-repos.js";

describe("sample repos allow-list (U37)", () => {
  it("defaults to the two devfellowship sample repos and installation 170661046", () => {
    const cfg = sampleReposFromEnv({});
    expect(cfg).toEqual({ agents: ["devfellowship/testmyagent-demo-agent"], tasks: ["devfellowship/testmyagent-demo-task"], installationId: 170661046 });
  });

  it("reads the env override, drops malformed entries and lower-cases", () => {
    const cfg = sampleReposFromEnv({ ITERA_SAMPLE_AGENT_REPOS: "Acme/One, bad repo ,acme/two", ITERA_SAMPLE_TASK_REPOS: "acme/t", ITERA_SAMPLE_INSTALLATION_ID: "7" });
    expect(cfg).toEqual({ agents: ["acme/one", "acme/two"], tasks: ["acme/t"], installationId: 7 });
  });

  it("matches per kind, case-insensitive", () => {
    const cfg = sampleReposFromEnv({});
    expect(isSampleRepo(cfg, "DevFellowship/TestMyAgent-Demo-Agent", "agent")).toBe(true);
    expect(isSampleRepo(cfg, "devfellowship/testmyagent-demo-agent", "task")).toBe(false);
    expect(isSampleRepo(cfg, "devfellowship/testmyagent-demo-task")).toBe(true);
    expect(isSampleRepo(cfg, "devfellowship/itera-certificacao-onchain")).toBe(false);
  });

  it("refuses any repo outside the allow-list (403), even one on the same installation", () => {
    const cfg = sampleReposFromEnv({});
    const refused = () => sampleInstallation(cfg, "devfellowship/dfl-schema", "agent", 170661046);
    expect(refused).toThrow(SampleRepoError);
    try {
      refused();
    } catch (e) {
      expect((e as SampleRepoError).status).toBe(403);
    }
  });

  it("answers the sample installation for an allow-listed repo, 503 when GitHub says another installation covers it", () => {
    const cfg = sampleReposFromEnv({});
    expect(sampleInstallation(cfg, "devfellowship/testmyagent-demo-agent", "agent", 170661046)).toBe(170661046);
    try {
      sampleInstallation(cfg, "devfellowship/testmyagent-demo-agent", "agent", null);
      expect.unreachable();
    } catch (e) {
      expect((e as SampleRepoError).status).toBe(503);
    }
  });

  it("source: the stored value wins, else derived from the allow-list", () => {
    const cfg = sampleReposFromEnv({});
    expect(repoSourceOf("github", cfg, "devfellowship/testmyagent-demo-agent", "agent")).toBe("github");
    expect(repoSourceOf(null, cfg, "devfellowship/testmyagent-demo-agent", "agent")).toBe("sample");
    expect(repoSourceOf(undefined, cfg, "alice/agents", "agent")).toBe("github");
  });
});
