import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config/index.js";
import app, { useConfig } from "../src/index.js";

/** Anonymous read+write on `geo`, so these tests carry no Authorization header. */
function config(corsBlock = "") {
  return loadConfig(
    `
${corsBlock}
authentication:
  anonymous:
    enabled: true
    namespaces: [geo]
    permissions: [read, write]
catalogs:
  omicidx:
    endpoint: https://catalog.example.com/acct/omicidx
    backend_warehouse: acct_omicidx
    backend_prefix: ""
    auth:
      bearer_token: backend-token
    capabilities:
      read: true
      write: true
`,
    {},
  );
}

let fetchMock: ReturnType<typeof vi.fn>;

function lastInit(): RequestInit {
  return (fetchMock.mock.calls.at(-1) as [string, RequestInit])[1];
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  useConfig(config());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// SPEC §19: backend failure → 502, in the ErrorModel envelope of SPEC §15.
describe("backend failure", () => {
  it("502s an unreachable backend", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));

    const res = await app.request("/v1/omicidx/namespaces/geo/tables");

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: { message: expect.stringContaining("unreachable"), type: "BadGatewayException", code: 502 },
    });
  });

  it("502s a backend that times out", async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error("aborted"), { name: "TimeoutError" }));

    const res = await app.request("/v1/omicidx/namespaces/geo/tables");

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: { message: expect.stringMatching(/timed out/) } });
  });

  it("arms an abort signal on every forwarded request", async () => {
    fetchMock.mockResolvedValue(Response.json({}));

    await app.request("/v1/omicidx/namespaces/geo/tables");

    expect(lastInit().signal).toBeInstanceOf(AbortSignal);
  });
});

describe("GET /v1/config transparency", () => {
  it("keeps the client's other query parameters, rewriting only warehouse", async () => {
    fetchMock.mockResolvedValue(Response.json({}));

    await app.request("/v1/config?warehouse=omicidx&scope=all");

    const url = new URL((fetchMock.mock.calls[0] as [string])[0]);
    expect(url.searchParams.get("warehouse")).toBe("acct_omicidx");
    expect(url.searchParams.get("scope")).toBe("all");
  });

  it("preserves the backend's response headers through the body rewrite", async () => {
    fetchMock.mockResolvedValue(
      Response.json({ overrides: {} }, { headers: { "X-Backend-Trace": "abc123", "Content-Length": "999" } }),
    );

    const res = await app.request("/v1/config?warehouse=omicidx");

    expect(res.headers.get("X-Backend-Trace")).toBe("abc123");
    // Described the pre-rewrite bytes; keeping it would truncate the response.
    expect(res.headers.get("Content-Length")).toBeNull();
  });
});

// fetch() hands back a decoded body with the backend's Content-Encoding still
// attached; forwarding that pair makes every gzip-capable client (PyIceberg,
// node fetch) fail to decompress plaintext.
describe("content encoding", () => {
  it("drops Content-Encoding and Content-Length from a decoded response", async () => {
    fetchMock.mockResolvedValue(
      Response.json({ namespaces: [] }, { headers: { "Content-Encoding": "gzip", "Content-Length": "999" } }),
    );

    const res = await app.request("/v1/omicidx/namespaces");

    expect(res.headers.get("Content-Encoding")).toBeNull();
    expect(res.headers.get("Content-Length")).toBeNull();
    expect(await res.json()).toEqual({ namespaces: [] });
  });

  it("leaves an uncompressed response alone", async () => {
    fetchMock.mockResolvedValue(Response.json({ namespaces: [] }, { headers: { "X-Backend-Trace": "abc" } }));

    const res = await app.request("/v1/omicidx/namespaces");

    expect(res.headers.get("X-Backend-Trace")).toBe("abc");
    expect(await res.json()).toEqual({ namespaces: [] });
  });
});

// SPEC §12: the gateway only carries the delegation header and the credentials
// that come back — it never touches either.
it("round-trips vended credentials untouched", async () => {
  const loadTable = {
    metadata: { "table-uuid": "u" },
    config: { "s3.access-key-id": "AK", "s3.secret-access-key": "SK", "s3.session-token": "TK" },
  };
  fetchMock.mockResolvedValue(Response.json(loadTable));

  const res = await app.request("/v1/omicidx/namespaces/geo/tables/t", {
    headers: { "X-Iceberg-Access-Delegation": "vended-credentials" },
  });

  expect(new Headers(lastInit().headers).get("X-Iceberg-Access-Delegation")).toBe("vended-credentials");
  expect(await res.json()).toEqual(loadTable);
});

// SPEC §11: browser clients (DuckDB-WASM) need preflight answered before auth.
describe("CORS", () => {
  const preflight = {
    method: "OPTIONS",
    headers: { Origin: "https://app.example.com", "Access-Control-Request-Method": "GET" },
  };

  it("answers a preflight 204 without authenticating or calling the backend", async () => {
    useConfig(config('cors:\n  enabled: true\n  origins: ["*"]\n'));

    const res = await app.request("/v1/omicidx/namespaces/private/tables", preflight);

    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("GET");
    const allowed = res.headers.get("Access-Control-Allow-Headers") ?? "";
    expect(allowed).toContain("Authorization");
    expect(allowed).toContain("X-Iceberg-Access-Delegation");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("adds the headers to ordinary gateway responses too", async () => {
    useConfig(config('cors:\n  enabled: true\n  origins: ["*"]\n'));
    fetchMock.mockResolvedValue(Response.json({}));

    const res = await app.request("/v1/omicidx/namespaces/geo/tables", {
      headers: { Origin: "https://app.example.com" },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("reflects only configured origins", async () => {
    useConfig(config('cors:\n  enabled: true\n  origins: ["https://app.example.com"]\n'));

    const allowed = await app.request("/v1/omicidx/namespaces/geo/tables", preflight);
    expect(allowed.headers.get("Access-Control-Allow-Origin")).toBe("https://app.example.com");

    const denied = await app.request("/v1/omicidx/namespaces/geo/tables", {
      ...preflight,
      headers: { ...preflight.headers, Origin: "https://evil.example.com" },
    });
    expect(denied.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("stays out of the way when disabled", async () => {
    fetchMock.mockResolvedValue(Response.json({}));

    const res = await app.request("/v1/omicidx/namespaces/geo/tables", {
      headers: { Origin: "https://app.example.com" },
    });

    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});
