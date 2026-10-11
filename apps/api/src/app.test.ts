import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { API_VERSION, createApp, SERVICE_NAME } from "./app.js";

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

describe("api routes", () => {
  it("GET / returns the service status as JSON", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    expect(await res.json()).toEqual({
      service: SERVICE_NAME,
      status: "ok",
      version: API_VERSION,
      routes: ["/", "/health", "/hello-world"],
    });
  });

  it("GET /health returns a minimal ok payload", async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("GET /hello-world returns plain text", async () => {
    const res = await fetch(`${baseUrl}/hello-world`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/plain/);
    expect(await res.text()).toBe("Hello, world!");
  });

  it("unknown routes return 404", async () => {
    const res = await fetch(`${baseUrl}/does-not-exist`);
    expect(res.status).toBe(404);
  });

  it("allows a known origin and sets the CORS header", async () => {
    const res = await fetch(`${baseUrl}/`, {
      headers: { Origin: "https://itera-agent-credentials.devfellowship.com" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "https://itera-agent-credentials.devfellowship.com",
    );
  });

  it("does not echo back an unknown origin", async () => {
    const res = await fetch(`${baseUrl}/`, {
      headers: { Origin: "https://evil.example.com" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("sets standard rate-limit headers on a response", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.headers.get("ratelimit-limit")).not.toBeNull();
  });
});
