import type { Context, Next } from "hono";

/**
 * Emits one structured JSON line per request to console.log (SPEC §13).
 * principal, namespace and backend come from the shared request context
 * (src/context.ts); they log as null on routes outside the `/v1/*` chain that
 * sets them, i.e. the health endpoints.
 */
export async function requestLogger(c: Context, next: Next) {
  const requestId = c.req.header("x-request-id") ?? crypto.randomUUID();
  c.set("requestId", requestId);

  const start = performance.now();
  await next();
  const latencyMs = performance.now() - start;

  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      requestId,
      clientIp: c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for") ?? null,
      principal: c.get("principal") ?? null,
      namespace: c.get("namespace") ?? null,
      backend: c.get("backend") ?? null,
      status: c.res.status,
      latencyMs,
    }),
  );
}
