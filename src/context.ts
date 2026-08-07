import type { Config } from "./config/index.js";

/** A gateway request path, parsed once at entry (SPEC §10). */
export type GatewayPath = {
  /** Public catalog prefix: the segment after `/v1/`, decoded. */
  prefix: string;
  /** Everything after the prefix, still percent-encoded — this is what the backend gets. */
  rest: string;
  /** Namespace from `.../namespaces/<ns>`, decoded exactly once; null when the path has none. */
  namespace: string | null;
};

/**
 * Splits `/v1/<prefix>/<rest>` off the RAW pathname. Never c.req.path: Hono's
 * getPath already percent-decodes it, so decoding that again turned a
 * multipart namespace (`geo%1Fsub`) into a key no config could match and blew
 * up on a malformed segment. Here the namespace is decoded once and `rest`
 * not at all, because Iceberg's %1F separators must reach the backend encoded.
 *
 * Returns null when a segment carries malformed percent-encoding — the caller
 * answers 400 rather than letting URIError surface as a 500 (SPEC §15).
 */
export function parseGatewayPath(rawPathname: string): GatewayPath | null {
  const [prefix = "", ...tail] = rawPathname.replace(/^\/v1\/?/, "").split("/");
  const namespaceSegment = tail[0] === "namespaces" ? (tail[1] ?? null) : null;
  try {
    return {
      prefix: decodeURIComponent(prefix),
      rest: tail.join("/"),
      namespace: namespaceSegment === null ? null : decodeURIComponent(namespaceSegment),
    };
  } catch {
    return null;
  }
}

/**
 * The request context every middleware shares (SPEC §7). Declaring the
 * variables here is what makes `c.get`/`c.set` typed — no string literals
 * re-invented per module, no casts at the read sites.
 *
 * Everything except `requestId` is set by the `/v1/*` chain in src/index.ts.
 * requestLogger and metricsMiddleware also run on /health and /ready, where
 * those variables are absent; both read them with `??`.
 */
declare module "hono" {
  interface ContextVariableMap {
    /** Client `x-request-id`, or a generated one (SPEC §13). */
    requestId: string;
    /** Gateway config, loaded once per isolate on the first `/v1/*` request. */
    config: Config;
    /** The request path, parsed once at gateway entry. */
    path: GatewayPath;
    /** Authenticated principal name (SPEC §8). */
    principal: string;
    /** Principal holds `write` — selects the catalog's write backend token (SPEC §12). */
    canWrite: boolean;
    /** Namespace the request is scoped to, or null when the path has none (SPEC §9). */
    namespace: string | null;
    /** Public catalog name the request resolved to (SPEC §10). */
    backend: string;
  }
}
