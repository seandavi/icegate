import { Hono, type Context } from "hono";
import { describe, expect, it } from "vitest";
import { authMiddleware, sha256Hex } from "../src/auth";
import { loadConfig, type Config } from "../src/config";

const ALICE_KEY = "icegate_test_alice_key";

async function buildConfig(): Promise<Config> {
  const digest = await sha256Hex(ALICE_KEY);
  const yaml = `
authentication:
  anonymous:
    enabled: true
    namespaces:
      - geo
    permissions:
      - read
  api_keys:
    enabled: true
    alice:
      sha256: ${digest}
      namespaces:
        - geo
        - tcga
      permissions:
        - read
catalogs:
  omicidx:
    endpoint: https://example.com
    backend_warehouse: w
    auth:
      bearer_token: t
    capabilities:
      read: true
      write: false
`;
  return loadConfig(yaml, {});
}

function buildApp(config: Config) {
  const app = new Hono();
  app.use("*", authMiddleware(config));
  app.get("/health", (c) => c.json({ status: "ok" }));
  app.all("*", (c: Context) => c.json({ principal: c.get("principal"), namespace: c.get("namespace") }));
  return app;
}

describe("auth middleware", () => {
  it("sets the principal for a valid API key", async () => {
    const app = buildApp(await buildConfig());
    const res = await app.request("/v1/omicidx/namespaces/geo/tables", {
      headers: { authorization: `Bearer ${ALICE_KEY}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ principal: "alice", namespace: "geo" });
  });

  it("rejects an unknown API key with 401", async () => {
    const app = buildApp(await buildConfig());
    const res = await app.request("/v1/omicidx/namespaces/geo/tables", {
      headers: { authorization: "Bearer icegate_bogus" },
    });
    expect(res.status).toBe(401);
  });

  it("allows anonymous access when no header is present and anonymous is enabled", async () => {
    const app = buildApp(await buildConfig());
    const res = await app.request("/v1/omicidx/namespaces/geo/tables");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ principal: "anonymous", namespace: "geo" });
  });

  it("rejects with 401 when no header is present and anonymous is disabled", async () => {
    const config = await buildConfig();
    config.authentication.anonymous!.enabled = false;
    const app = buildApp(config);
    const res = await app.request("/v1/omicidx/namespaces/geo/tables");
    expect(res.status).toBe(401);
  });

  it("never falls back to anonymous for an unmatched bearer, even with anonymous enabled", async () => {
    const app = buildApp(await buildConfig());
    const res = await app.request("/v1/omicidx/namespaces/geo/tables", {
      headers: { authorization: "Bearer icegate_bogus" },
    });
    expect(res.status).toBe(401);
  });

  it("denies a namespace the principal is not scoped to with 403", async () => {
    const app = buildApp(await buildConfig());
    const res = await app.request("/v1/omicidx/namespaces/private/tables", {
      headers: { authorization: `Bearer ${ALICE_KEY}` },
    });
    expect(res.status).toBe(403);
  });

  it("denies a write operation for a read-only principal with 403", async () => {
    const app = buildApp(await buildConfig());
    const res = await app.request("/v1/omicidx/namespaces/geo/tables", {
      method: "POST",
      headers: { authorization: `Bearer ${ALICE_KEY}` },
    });
    expect(res.status).toBe(403);
  });

  it("classifies POST .../plan as a read operation", async () => {
    const app = buildApp(await buildConfig());
    const res = await app.request("/v1/omicidx/namespaces/geo/tables/t1/plan", {
      method: "POST",
      headers: { authorization: `Bearer ${ALICE_KEY}` },
    });
    expect(res.status).toBe(200);
  });

  it("bypasses auth entirely for /health", async () => {
    const config = await buildConfig();
    config.authentication.anonymous!.enabled = false;
    const app = buildApp(config);
    const res = await app.request("/health");
    expect(res.status).toBe(200);
  });

  it("requires only authentication for paths without a namespace", async () => {
    const app = buildApp(await buildConfig());
    const res = await app.request("/v1/config", {
      headers: { authorization: `Bearer ${ALICE_KEY}` },
    });
    expect(res.status).toBe(200);
  });
});
