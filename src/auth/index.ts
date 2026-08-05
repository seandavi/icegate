import type { Context, Next } from "hono";
import type { Config } from "../config/index.js";

type Permission = "read" | "write";
type Principal = { name: string; namespaces: string[]; permissions: Permission[] };

// SPEC §16: these endpoints bypass auth entirely.
const BYPASS_PATHS = new Set(["/health", "/ready", "/metrics"]);

/** SHA-256 hex digest via Web Crypto — runs on Workers, unlike node:crypto. */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function findApiKeyPrincipal(
  bearer: string,
  apiKeys: NonNullable<Config["authentication"]["api_keys"]>,
): Promise<Principal | null> {
  const digest = await sha256Hex(bearer);
  for (const [name, entry] of Object.entries(apiKeys)) {
    if (name === "enabled") continue;
    const principal = entry as { sha256: string; namespaces: string[]; permissions: Permission[] };
    if (principal.sha256.toLowerCase() === digest) {
      return { name, namespaces: principal.namespaces, permissions: principal.permissions };
    }
  }
  return null;
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
 * Authentication + authorization middleware factory (SPEC §7-9). Bearer
 * token → SHA-256 → principal lookup; no header → anonymous if enabled;
 * unmatched bearer never falls through to anonymous. Namespace-scoped
 * paths additionally require the principal's namespaces/permissions to
 * cover the request; paths without a namespace need only authentication.
 * auth_failures_total is incremented by the existing metrics middleware,
 * which already counts every 401/403 response — no separate call needed here.
 */
export function authMiddleware(config: Config) {
  const auth = config.authentication;

  return async function auth_(c: Context, next: Next) {
    if (BYPASS_PATHS.has(c.req.path)) {
      return next();
    }

    const bearer = c.req.header("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];

    let principal: Principal;
    if (bearer !== undefined) {
      if (!auth.api_keys?.enabled) return unauthorized(c);
      const matched = await findApiKeyPrincipal(bearer, auth.api_keys);
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
  };
}
