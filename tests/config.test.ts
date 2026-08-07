import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";

const env = { CF_ACCOUNT_ID: "acct123", CF_API_TOKEN: "tok_secret" };

// Mirrors examples/icegate.yaml (inlined: the Workers test runtime has no
// filesystem access, and text-module imports need extra ambient types).
const exampleYaml = `
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
      sha256: 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08
      namespaces:
        - geo
        - tcga
      permissions:
        - read

catalogs:
  omicidx:
    endpoint: https://catalog.cloudflarestorage.com/\${CF_ACCOUNT_ID}/omicidx
    backend_warehouse: \${CF_ACCOUNT_ID}_omicidx
    backend_prefix: ""
    auth:
      bearer_token: \${CF_API_TOKEN}
    capabilities:
      read: true
      write: false
`;

describe("loadConfig", () => {
  it("parses a valid config and interpolates env vars", () => {
    const config = loadConfig(exampleYaml, env);
    expect(config.catalogs.omicidx.endpoint).toBe("https://catalog.cloudflarestorage.com/acct123/omicidx");
    expect(config.catalogs.omicidx.backend_warehouse).toBe("acct123_omicidx");
    expect(config.catalogs.omicidx.auth.bearer_token).toBe("tok_secret");
    expect(config.catalogs.omicidx.backend_prefix).toBe("");
  });

  it("fails on invalid YAML", () => {
    expect(() => loadConfig("catalogs:\n  omicidx:\n  bad indent\n- x", env)).toThrow();
  });

  it("rejects an unknown top-level key", () => {
    const yaml = `
authentication:
  anonymous:
    enabled: true
catalogs:
  foo:
    endpoint: https://example.com
    backend_warehouse: w
    auth:
      bearer_token: t
    capabilities:
      read: true
      write: false
bogus: true
`;
    expect(() => loadConfig(yaml, env)).toThrow(/bogus/);
  });

  it("rejects an unknown nested key", () => {
    const yaml = `
authentication:
  anonymous:
    enabled: true
catalogs:
  foo:
    endpoint: https://example.com
    backend_warehouse: w
    auth:
      bearer_token: t
      extra: nope
    capabilities:
      read: true
      write: false
`;
    expect(() => loadConfig(yaml, env)).toThrow(/catalogs\.foo\.auth/);
    expect(() => loadConfig(yaml, env)).toThrow(/extra/);
  });

  it("throws with the variable name and config path when an env var is missing", () => {
    const yaml = `
authentication:
  anonymous:
    enabled: true
catalogs:
  foo:
    endpoint: https://example.com
    backend_warehouse: w
    auth:
      bearer_token: \${MISSING_TOKEN}
    capabilities:
      read: true
      write: false
`;
    expect(() => loadConfig(yaml, env)).toThrow(/MISSING_TOKEN/);
    expect(() => loadConfig(yaml, env)).toThrow(/catalogs\.foo\.auth\.bearer_token/);
  });

  it("rejects a catalog name containing a slash", () => {
    const yaml = `
authentication:
  anonymous:
    enabled: true
catalogs:
  "geo/tcga":
    endpoint: https://example.com
    backend_warehouse: w
    auth:
      bearer_token: t
    capabilities:
      read: true
      write: false
`;
    expect(() => loadConfig(yaml, env)).toThrow(/single path segment/);
  });

  it("requires at least one catalog", () => {
    const yaml = `
authentication:
  anonymous:
    enabled: true
catalogs: {}
`;
    expect(() => loadConfig(yaml, env)).toThrow(/at least one catalog/);
  });

  it("accepts an optional bearer_token_write", () => {
    const yaml = exampleYaml.replace("bearer_token: \${CF_API_TOKEN}", "bearer_token: ro\n      bearer_token_write: rw");
    const config = loadConfig(yaml, env);
    expect(config.catalogs.omicidx.auth).toEqual({ bearer_token: "ro", bearer_token_write: "rw" });
  });

  it("accepts anonymous and api_keys authorization scoping shapes", () => {
    const config = loadConfig(exampleYaml, env);
    expect(config.authentication.anonymous?.namespaces).toEqual(["geo"]);
    expect(config.authentication.anonymous?.permissions).toEqual(["read"]);
    expect(config.authentication.api_keys?.alice).toEqual({
      sha256: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
      namespaces: ["geo", "tcga"],
      permissions: ["read"],
    });
  });
});
