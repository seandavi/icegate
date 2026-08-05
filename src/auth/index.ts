import type { Context, Next } from "hono";
import type { Config } from "../config/index.js";

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

// SPEC §10: `/v1/<prefix>/namespaces/<ns>/...`. `<ns>` may be a single
// URL-encoded segment representing multiple levels joined by %1F; per
// ticket scope we don't split on that separator, just decode the segment
// and use it whole as the namespace key.
function extractNamespace(pathname: string): string | null {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length >= 4 && segments[0] === "v1" && segments[2] === "namespaces") {
    return decodeURIComponent(segments[3]);
  }
  return null;
}

// SPEC §9: read = GET/HEAD, plus POST scan-planning/metrics endpoints.
// Everything else is write.
function classifyOperation(method: string, pathname: string): Permission {
  const m = method.toUpperCase();
  if (m === "GET" || m === "HEAD") return "read";
  if (m === "POST" && (pathname.endsWith("/plan") || pathname.endsWith("/tasks") || pathname.endsWith("/metrics"))) {
    return "read";
  }
  return "write";
}

function unauthorized(c: Context) {
  return c.json({ error: "unauthorized" }, 401);
}

function forbidden(c: Context) {
  return c.json({ error: "forbidden" }, 403);
}

/**
 * Authentication + authorization middleware (SPEC §7-9). Bearer token →
 * SHA-256 → principal lookup; no header → anonymous if enabled; unmatched
 * bearer never falls through to anonymous. Namespace-scoped paths
 * additionally require the principal's namespaces/permissions to cover the
 * request; paths without a namespace need only authentication.
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
    if (!auth.api_keys?.enabled) return unauthorized(c);
    const matched = principalsByDigest(config).get(await sha256Hex(bearer));
    if (!matched) return unauthorized(c);
    principal = matched;
  } else {
    if (!auth.anonymous?.enabled) return unauthorized(c);
    principal = {
      name: "anonymous",
      namespaces: auth.anonymous.namespaces ?? [],
      permissions: auth.anonymous.permissions ?? [],
    };
  }

  c.set("principal", principal.name);

  const namespace = extractNamespace(c.req.path);
  c.set("namespace", namespace);

  if (namespace !== null) {
    const op = classifyOperation(c.req.method, c.req.path);
    if (!principal.namespaces.includes(namespace) || !principal.permissions.includes(op)) {
      return forbidden(c);
    }
  }

  await next();
}
