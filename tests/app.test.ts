import { describe, expect, it } from "vitest";
import app, { useConfig } from "../src/index.js";
import { sha256Hex } from "../src/auth/index.js";
import { loadConfig } from "../src/config/index.js";

const KEY = "icegate_testkey00000000000000000000";

const yaml = async () => `
authentication:
  anonymous:
    enabled: false
  api_keys:
    enabled: true
    alice:
      sha256: ${await sha256Hex(KEY)}
      namespaces: [geo]
      permissions: [read]
catalogs:
  omicidx:
    endpoint: https://backend.example.com/acct/bucket
    backend_warehouse: acct_bucket
    auth:
      bearer_token: dummy
    capabilities:
      read: true
      write: false
`;

describe("app pipeline (auth mounted ahead of routes)", () => {
  it("401s an unauthenticated /v1/* request through the real app", async () => {
    useConfig(loadConfig(await yaml(), {}));
    const res = await app.request("/v1/config?warehouse=omicidx");
    expect(res.status).toBe(401);
  });

  it("passes auth with a valid key and reaches routing (404 unknown prefix)", async () => {
    useConfig(loadConfig(await yaml(), {}));
    const res = await app.request("/v1/nosuch/namespaces", {
      headers: { authorization: `Bearer ${KEY}` },
    });
    expect(res.status).toBe(404);
  });
});
