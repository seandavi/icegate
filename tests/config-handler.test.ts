import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config";
import { catalogRoutes } from "../src/routing/routes";

const config = {
  authentication: { anonymous: { enabled: true } },
  catalogs: {
    omicidx: {
      endpoint: "https://catalog.example.com/acct/omicidx",
      backend_warehouse: "acct_omicidx",
      backend_prefix: "",
      auth: { bearer_token: "backend-token" },
      capabilities: { read: true, write: false },
    },
    prefixed: {
      endpoint: "https://lakekeeper.example.com",
      backend_warehouse: "wh",
      backend_prefix: "main",
      auth: { bearer_token: "other-token" },
      capabilities: { read: true, write: true },
    },
  },
} satisfies Config;

const app = catalogRoutes(config);

let fetchMock: ReturnType<typeof vi.fn>;

function respond(body: unknown, init: ResponseInit = {}) {
  fetchMock.mockResolvedValue(Response.json(body, init));
}

function calledWith() {
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  return { url, init, headers: new Headers(init.headers) };
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GET /v1/config", () => {
  it("404s an unknown warehouse without calling the backend", async () => {
    const res = await app.request("/v1/config?warehouse=nope");
    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("404s a missing warehouse parameter", async () => {
    expect((await app.request("/v1/config")).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forwards with backend_warehouse substituted and the catalog's bearer token", async () => {
    respond({});
    await app.request("/v1/config?warehouse=omicidx", {
      headers: { Authorization: "Bearer icegate_clientkey", "X-Iceberg-Access-Delegation": "vended-credentials" },
    });

    const { url, headers } = calledWith();
    expect(url).toBe("https://catalog.example.com/acct/omicidx/v1/config?warehouse=acct_omicidx");
    expect(headers.get("Authorization")).toBe("Bearer backend-token");
    expect(headers.get("X-Iceberg-Access-Delegation")).toBe("vended-credentials");
    expect(headers.has("host")).toBe(false);
  });

  it("rewrites overrides and drops defaults.uri, keeping endpoints", async () => {
    const endpoints = ["GET /v1/{prefix}/namespaces"];
    respond({
      defaults: { uri: "https://catalog.example.com", "clients.region": "auto" },
      overrides: { prefix: "acct_omicidx", warehouse: "acct_omicidx" },
      endpoints,
    });

    const res = await app.request("https://gw.example.com/v1/config?warehouse=omicidx");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      defaults: { "clients.region": "auto" },
      overrides: { prefix: "omicidx", uri: "https://gw.example.com", warehouse: "acct_omicidx" },
      endpoints,
    });
  });

  it("preserves a non-200 backend status", async () => {
    respond({ error: { message: "boom" } }, { status: 503 });
    const res = await app.request("/v1/config?warehouse=omicidx");
    expect(res.status).toBe(503);
  });
});

describe("the app's bundled config", () => {
  it("loads config.yaml on the first gateway request and routes with it", async () => {
    const { default: app } = await import("../src/index");
    respond({});

    const res = await app.request("/v1/config?warehouse=omicidx");
    expect(res.status).toBe(200);
    expect(calledWith().url).toBe(
      "https://catalog.example.invalid/dev-account/omicidx/v1/config?warehouse=dev-account_omicidx",
    );
  });
});

describe("/v1/:prefix/*", () => {
  it("404s an unknown prefix without calling the backend", async () => {
    const res = await app.request("/v1/nope/namespaces");
    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("builds the backend URL with an empty backend_prefix and preserves the query", async () => {
    respond({ namespaces: [] });
    await app.request("/v1/omicidx/namespaces?parent=geo");
    expect(calledWith().url).toBe("https://catalog.example.com/acct/omicidx/v1/namespaces?parent=geo");
  });

  it("inserts a non-empty backend_prefix after /v1/", async () => {
    respond({ namespaces: [] });
    await app.request("/v1/prefixed/namespaces/geo/tables");
    expect(calledWith().url).toBe("https://lakekeeper.example.com/v1/main/namespaces/geo/tables");
  });

  it("keeps multipart namespaces percent-encoded", async () => {
    respond({});
    await app.request("/v1/omicidx/namespaces/geo%1Fsub/tables");
    expect(calledWith().url).toBe("https://catalog.example.com/acct/omicidx/v1/namespaces/geo%1Fsub/tables");
  });

  it("replaces the client Authorization header and forwards the method and body", async () => {
    respond({}, { status: 201 });
    const res = await app.request("/v1/omicidx/namespaces", {
      method: "POST",
      headers: { Authorization: "Bearer icegate_clientkey", "Content-Type": "application/json" },
      body: JSON.stringify({ namespace: ["geo"] }),
    });

    const { init, headers } = calledWith();
    expect(init.method).toBe("POST");
    expect(headers.get("Authorization")).toBe("Bearer backend-token");
    expect(res.status).toBe(201);
  });

  it("rewrites a Location header from the backend prefix to the public one", async () => {
    fetchMock.mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { Location: "https://catalog.example.com/acct/omicidx/v1/namespaces/geo" },
      }),
    );

    const res = await app.request("https://gw.example.com/v1/omicidx/namespaces");
    expect(res.headers.get("Location")).toBe("https://gw.example.com/v1/omicidx/namespaces/geo");
  });

  it("leaves a Location pointing elsewhere untouched", async () => {
    fetchMock.mockResolvedValue(
      new Response(null, { status: 302, headers: { Location: "https://elsewhere.example.com/login" } }),
    );

    const res = await app.request("https://gw.example.com/v1/omicidx/namespaces");
    expect(res.headers.get("Location")).toBe("https://elsewhere.example.com/login");
  });
});
