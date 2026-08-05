import { describe, expect, it } from "vitest";
import type { Config } from "../src/config";
import { buildBackendUrl, resolveCatalog, transformConfigResponse } from "../src/routing";

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

describe("resolveCatalog", () => {
  it("returns the catalog with its public name", () => {
    expect(resolveCatalog(config, "omicidx")?.name).toBe("omicidx");
    expect(resolveCatalog(config, "omicidx")?.backend_warehouse).toBe("acct_omicidx");
  });

  it("returns null for an unknown prefix", () => {
    expect(resolveCatalog(config, "nope")).toBeNull();
  });
});

describe("buildBackendUrl", () => {
  const omicidx = resolveCatalog(config, "omicidx")!;
  const prefixed = resolveCatalog(config, "prefixed")!;

  it("joins under the endpoint's own path with an empty backend_prefix", () => {
    expect(buildBackendUrl(omicidx, "namespaces/geo/tables")).toBe(
      "https://catalog.example.com/acct/omicidx/v1/namespaces/geo/tables",
    );
  });

  it("inserts a non-empty backend_prefix after /v1/", () => {
    expect(buildBackendUrl(prefixed, "namespaces")).toBe("https://lakekeeper.example.com/v1/main/namespaces");
  });

  it("never doubles slashes", () => {
    const trailing = { ...omicidx, endpoint: "https://catalog.example.com/acct/omicidx/" };
    expect(buildBackendUrl(trailing, "/config")).toBe("https://catalog.example.com/acct/omicidx/v1/config");
  });

  it("appends the query when given one", () => {
    expect(buildBackendUrl(omicidx, "config", new URLSearchParams({ warehouse: "acct_omicidx" }))).toBe(
      "https://catalog.example.com/acct/omicidx/v1/config?warehouse=acct_omicidx",
    );
    expect(buildBackendUrl(omicidx, "namespaces", "?parent=geo")).toBe(
      "https://catalog.example.com/acct/omicidx/v1/namespaces?parent=geo",
    );
    expect(buildBackendUrl(omicidx, "namespaces", "")).toBe("https://catalog.example.com/acct/omicidx/v1/namespaces");
  });
});

describe("transformConfigResponse", () => {
  it("sets overrides.prefix and overrides.uri", () => {
    const out = transformConfigResponse({}, "omicidx", "https://gw.example.com");
    expect(out.overrides).toEqual({ prefix: "omicidx", uri: "https://gw.example.com" });
  });

  it("overwrites a backend-supplied prefix and uri", () => {
    const out = transformConfigResponse(
      { overrides: { prefix: "acct_omicidx", uri: "https://catalog.example.com", warehouse: "acct_omicidx" } },
      "omicidx",
      "https://gw.example.com",
    );
    expect(out.overrides).toEqual({
      prefix: "omicidx",
      uri: "https://gw.example.com",
      warehouse: "acct_omicidx",
    });
  });

  it("deletes defaults.uri and keeps other defaults", () => {
    const out = transformConfigResponse(
      { defaults: { uri: "https://catalog.example.com", "clients.region": "auto" } },
      "omicidx",
      "https://gw.example.com",
    );
    expect(out.defaults).toEqual({ "clients.region": "auto" });
    expect(out.defaults).not.toHaveProperty("uri");
  });

  it("leaves defaults absent when the backend sent none", () => {
    expect(transformConfigResponse({}, "omicidx", "https://gw.example.com")).not.toHaveProperty("defaults");
  });

  it("forwards the endpoints list and any unknown keys unchanged", () => {
    const endpoints = ["GET /v1/{prefix}/namespaces", "POST /v1/{prefix}/namespaces"];
    const out = transformConfigResponse({ endpoints, "some-future-key": 1 }, "omicidx", "https://gw.example.com");
    expect(out.endpoints).toEqual(endpoints);
    expect(out["some-future-key"]).toBe(1);
  });

  it("does not mutate the backend body", () => {
    const body = { defaults: { uri: "https://catalog.example.com" }, overrides: {} };
    transformConfigResponse(body, "omicidx", "https://gw.example.com");
    expect(body.defaults.uri).toBe("https://catalog.example.com");
  });
});
