import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { createVersionHandler, resolveCommit } from "./version.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const missing = () => {
  throw new Error("ENOENT");
};

describe("resolveCommit", () => {
  it("prefers the GIT_COMMIT env var", () => {
    expect(resolveCommit({ env: { GIT_COMMIT: SHA }, readFile: missing })).toBe(SHA);
  });
  it("reads the file the Dockerfile writes", () => {
    expect(resolveCommit({ env: {}, readFile: () => `${SHA}\n`, commitFile: "/app/GIT_COMMIT" })).toBe(SHA);
  });
  it("answers unknown for a missing file, a bad value or the unknown marker", () => {
    expect(resolveCommit({ env: {}, readFile: missing })).toBe("unknown");
    expect(resolveCommit({ env: { GIT_COMMIT: "XYZ" }, readFile: () => "not-a-sha" })).toBe("unknown");
    expect(resolveCommit({ env: {}, readFile: () => "unknown" })).toBe("unknown");
  });
});

describe("GET /version", () => {
  let server: Server | undefined;
  afterEach(() => new Promise<void>((done) => (server ? server.close(() => done()) : done())));

  it("answers JSON with the service and the commit, never cached", async () => {
    const app = express();
    app.get("/version", createVersionHandler({ env: { GIT_COMMIT: SHA } }));
    server = await new Promise<Server>((r) => {
      const s = app.listen(0, "127.0.0.1", () => r(s));
    });
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/version`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ service: "testmyagent-api", commit: SHA });
  });
});
