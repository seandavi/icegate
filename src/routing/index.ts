import type { Config } from "../config/index.js";

export type Catalog = Config["catalogs"][string] & { name: string };

/** Looks up a catalog by its public prefix (SPEC §10: dictionary lookup, no regex). */
export function resolveCatalog(config: Config, publicPrefix: string): Catalog | null {
  const catalog = config.catalogs[publicPrefix];
  return catalog ? { name: publicPrefix, ...catalog } : null;
}

/**
 * Backend base URI, always with a trailing slash:
 * `<endpoint>/v1/` or `<endpoint>/v1/<backend_prefix>/`.
 * `endpoint` may carry its own path segments (R2 Data Catalog serves at
 * `.../<account_id>/<bucket>`), which precede `/v1` (SPEC §10).
 */
export function backendBase(catalog: Catalog): string {
  const endpoint = catalog.endpoint.replace(/\/+$/, "");
  const prefix = catalog.backend_prefix ? `${catalog.backend_prefix}/` : "";
  return `${endpoint}/v1/${prefix}`;
}

/** `<endpoint>/v1/[<backend_prefix>/]<rest>[?<query>]`. */
export function buildBackendUrl(catalog: Catalog, rest: string, query?: URLSearchParams | string): string {
  const search = typeof query === "string" ? query.replace(/^\?/, "") : (query?.toString() ?? "");
  return `${backendBase(catalog)}${rest.replace(/^\/+/, "")}${search ? `?${search}` : ""}`;
}

export type ConfigBody = {
  defaults?: Record<string, unknown>;
  overrides?: Record<string, unknown>;
  [key: string]: unknown;
};

/**
 * SPEC §11: force clients back through the gateway. `overrides.prefix` becomes
 * the public catalog name, `overrides.uri` the gateway URL, and any
 * `defaults.uri` is deleted — PyIceberg merges both maps and re-reads `uri`,
 * so a surviving backend `uri` makes clients address the backend directly.
 * Everything else (notably `endpoints`) is forwarded untouched.
 */
export function transformConfigResponse(
  backendBody: ConfigBody,
  catalogName: string,
  publicGatewayUrl: string,
): ConfigBody {
  const { defaults, ...rest } = backendBody;
  const out: ConfigBody = {
    ...rest,
    overrides: { ...backendBody.overrides, prefix: catalogName, uri: publicGatewayUrl },
  };
  if (defaults) {
    const { uri: _dropped, ...keptDefaults } = defaults;
    out.defaults = keptDefaults;
  }
  return out;
}
