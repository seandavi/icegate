import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../src/auth/index.js";
import { loadConfig } from "../src/config/index.js";
import app, { useConfig } from "../src/index.js";
import { renderMetrics } from "../src/metrics/index.js";

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

const alice = { authorization: `Bearer ${KEY}` };

/** Last line requestLogger emitted (SPEC §13). */
function lastLogLine(spy: { mock: { calls: unknown[][] } }) {
  return JSON.parse(spy.mock.calls.at(-1)![0] as string);
}

function backendErrors(backend: string): number {
  const match = renderMetrics().match(new RegExp(`backend_errors_total\\{backend="${backend}"\\} (\\d+)`));
  return match ? Number(match[1]) : 0;
}

beforeEach(async () => {
  useConfig(loadConfig(await yaml(), {}));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("app pipeline (auth mounted ahead of routes)", () => {
  it("401s an unauthenticated /v1/* request through the real app", async () => {
    const res = await app.request("/v1/config?warehouse=omicidx");
    expect(res.status).toBe(401);
  });

  it("passes auth with a valid key and reaches routing (404 unknown prefix)", async () => {
    const res = await app.request("/v1/nosuch/namespaces", { headers: alice });
    expect(res.status).toBe(404);
  });
});

// One dispatch, one context (#17): what auth and routing set has to reach the
// logging and metrics middlewares wrapping them.
describe("request context reaches logging and metrics", () => {
  it("logs the principal, namespace and backend of a /v1/* request", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Response.json({})));
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    const res = await app.request("/v1/omicidx/namespaces/geo/tables", { headers: alice });

    expect(res.status).toBe(200);
    expect(lastLogLine(spy)).toMatchObject({
      principal: "alice",
      namespace: "geo",
      backend: "omicidx",
      status: 200,
    });
  });

  it("counts a 5xx backend response against the resolved backend", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Response.json({ error: "boom" }, { status: 503 })));
    const before = backendErrors("omicidx");

    const res = await app.request("/v1/omicidx/namespaces/geo/tables", { headers: alice });

    expect(res.status).toBe(503);
    expect(backendErrors("omicidx")).toBe(before + 1);
  });
});
