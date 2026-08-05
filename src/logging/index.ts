import type { Context, Next } from "hono";

/**
 * Emits one structured JSON line per request to console.log.
 * Auth/routing land in later tickets; principal, namespace, and backend
 * are read from context vars and log as null until those middlewares set them.
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
