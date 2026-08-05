import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../src/auth";
import { type Config, loadConfig } from "../src/config";
import app, { useConfig } from "../src/index";

const ALICE_KEY = "icegate_test_alice_key";

// alice is scoped to a namespace anonymous cannot reach (tcga), so a 200 there
// proves the key matched rather than falling through to anonymous.
async function buildConfig(): Promise<Config> {
  const yaml = `
authentication:
  anonymous:
    enabled: true
    namespaces: [geo]
    permissions: [read]
  api_keys:
    enabled: true
    alice:
      sha256: ${await sha256Hex(ALICE_KEY)}
      namespaces: [geo, tcga]
      permissions: [read]
catalogs:
  omicidx:
    endpoint: https://catalog.example.com/acct/omicidx
    backend_warehouse: acct_omicidx
    auth:
      bearer_token: backend-token
    capabilities:
      read: true
      write: false
`;
  return loadConfig(yaml, {});
}

const alice = { authorization: `Bearer ${ALICE_KEY}` };

beforeEach(async () => {
  vi.stubGlobal("fetch", vi.fn(() => Response.json({})));
  useConfig(await buildConfig());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("auth, through the composed app", () => {
  it("admits a valid API key to a namespace only that key is scoped to", async () => {
    const res = await app.request("/v1/omicidx/namespaces/tcga/tables", { headers: alice });
    expect(res.status).toBe(200);
  });

  it("rejects an unknown API key with 401", async () => {
    const res = await app.request("/v1/omicidx/namespaces/geo/tables", {
      headers: { authorization: "Bearer icegate_bogus" },
    });
    expect(res.status).toBe(401);
  });

  it("allows anonymous access when no header is present and anonymous is enabled", async () => {
    const res = await app.request("/v1/omicidx/namespaces/geo/tables");
    expect(res.status).toBe(200);
  });

  it("rejects with 401 when no header is present and anonymous is disabled", async () => {
    const config = await buildConfig();
    config.authentication.anonymous!.enabled = false;
    useConfig(config);
    const res = await app.request("/v1/omicidx/namespaces/geo/tables");
    expect(res.status).toBe(401);
  });

  it("never falls back to anonymous for an unmatched bearer, even with anonymous enabled", async () => {
    const res = await app.request("/v1/omicidx/namespaces/geo/tables", {
      headers: { authorization: "Bearer icegate_bogus" },
    });
    expect(res.status).toBe(401);
  });

  it("denies a namespace the principal is not scoped to with 403", async () => {
    const res = await app.request("/v1/omicidx/namespaces/private/tables", { headers: alice });
    expect(res.status).toBe(403);
  });

  it("denies anonymous the namespace only alice is scoped to with 403", async () => {
    const res = await app.request("/v1/omicidx/namespaces/tcga/tables");
    expect(res.status).toBe(403);
  });

  it("denies a write operation for a read-only principal with 403", async () => {
    const res = await app.request("/v1/omicidx/namespaces/geo/tables", { method: "POST", headers: alice });
    expect(res.status).toBe(403);
  });

  it("classifies POST .../plan as a read operation", async () => {
    const res = await app.request("/v1/omicidx/namespaces/geo/tables/t1/plan", { method: "POST", headers: alice });
    expect(res.status).toBe(200);
  });

  it("bypasses auth entirely for /health (SPEC §16)", async () => {
    const config = await buildConfig();
    config.authentication.anonymous!.enabled = false;
    useConfig(config);
    const res = await app.request("/health");
    expect(res.status).toBe(200);
  });

  it("requires only authentication for paths without a namespace", async () => {
    const res = await app.request("/v1/config?warehouse=omicidx", { headers: alice });
    expect(res.status).toBe(200);
  });
});
