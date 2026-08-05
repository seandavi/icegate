import type { Context, Next } from "hono";
import type { Config } from "../config/index.js";
import { errorResponse } from "../errors.js";
import { resolveCatalog } from "../routing/index.js";

type Permission = "read" | "write";
export type Principal = { name: string; namespaces: string[]; permissions: Permission[] };

/** SHA-256 hex digest via Web Crypto — runs on Workers, unlike node:crypto. */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// digest → principal, built once per config object. Config is memoized for the
// isolate's lifetime (src/index.ts), so this never runs on a hot path.
const principalIndexes = new WeakMap<Config, Map<string, Principal>>();

function principalsByDigest(config: Config): Map<string, Principal> {
  let index = principalIndexes.get(config);
  if (!index) {
    index = new Map();
    for (const [name, entry] of Object.entries(config.authentication.api_keys ?? {})) {
      // The reserved `enabled` flag is the only non-principal key.
      if (typeof entry !== "object") continue;
      index.set(entry.sha256.toLowerCase(), {
        name,
        namespaces: entry.namespaces,
        permissions: entry.permissions,
      });
    }
    principalIndexes.set(config, index);
  }
  return index;
}

// SPEC §9: read = GET/HEAD, plus POST scan-planning/metrics endpoints.
// Everything else is write.
function classifyOperation(method: string, rest: string): Permission {
  const m = method.toUpperCase();
  if (m === "GET" || m === "HEAD") return "read";
  if (m === "POST" && (rest.endsWith("/plan") || rest.endsWith("/tasks") || rest.endsWith("/metrics"))) {
    return "read";
  }
  return "write";
}

// SPEC §9: a multipart namespace is one segment whose levels are joined by
// 0x1F; scoping is checked against its top level, so `geo` covers `geo.sub`.
const NAMESPACE_SEPARATOR = "\u001f";

function unauthorized() {
  return errorResponse(401, "NotAuthorizedException", "unauthorized");
}

function forbidden() {
  return errorResponse(403, "ForbiddenException", "forbidden");
}

/**
 * Authentication + authorization middleware (SPEC §7-9, §12). Bearer token →
 * SHA-256 → principal lookup; no header → anonymous if enabled; unmatched
 * bearer never falls through to anonymous.
 *
 * `/v1/config` is the one reserved, catalog-less endpoint (SPEC §10) — it
 * gets authentication only. Every other `/v1/<prefix>/*` request is
 * classified read/write (SPEC §9) and checked against the principal's
 * permissions and, additionally, the catalog's `capabilities` (SPEC §12);
 * namespace scoping applies only when the path carries a namespace.
 *
 * Mounted on `/v1/*` only, so the health endpoints (SPEC §16) bypass it by
 * construction. auth_failures_total is incremented by the metrics middleware,
 * which already counts every 401/403 response — no separate call needed here.
 */
export async function authMiddleware(c: Context, next: Next) {
  const config = c.get("config");
  const auth = config.authentication;

  const bearer = c.req.header("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];

  let principal: Principal;
  if (bearer !== undefined) {
    if (!auth.api_keys?.enabled) return unauthorized();
    const matched = principalsByDigest(config).get(await sha256Hex(bearer));
    if (!matched) return unauthorized();
    principal = matched;
  } else {
    if (!auth.anonymous?.enabled) return unauthorized();
    principal = {
      name: "anonymous",
      namespaces: auth.anonymous.namespaces ?? [],
      permissions: auth.anonymous.permissions ?? [],
    };
  }

  c.set("principal", principal.name);

  const { prefix, rest, namespace } = c.get("path");
  c.set("namespace", namespace);

  // SPEC §10: `config` is the reserved endpoint name, never a real catalog prefix.
  if (prefix === "config") {
    await next();
    return;
  }

  const op = classifyOperation(c.req.method, rest);
  if (!principal.permissions.includes(op)) return forbidden();

  if (namespace !== null) {
    const topLevel = namespace.split(NAMESPACE_SEPARATOR)[0];
    if (!principal.namespaces.includes(topLevel)) return forbidden();
  }

  // SPEC §12: capabilities.read/write blocks at the REST layer regardless of
  // the principal's own permissions. Unknown prefix → leave the 404 to routing.
  const catalog = resolveCatalog(config, prefix);
  if (catalog && !catalog.capabilities[op]) return forbidden();

  await next();
}
