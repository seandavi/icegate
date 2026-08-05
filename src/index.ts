import { Hono } from "hono";
import { authMiddleware } from "./auth/index.js";
import { type Config, loadConfig } from "./config/index.js";
import { requestLogger } from "./logging/index.js";
import { metricsMiddleware } from "./metrics/index.js";
import { parseGatewayPath } from "./context.js";
import { catalogRoutes } from "./routing/routes.js";

const app = new Hono();

app.use("*", metricsMiddleware);
app.use("*", requestLogger);

app.get("/health", (c) => c.json({ status: "ok" }));
app.get("/ready", (c) => c.json({ status: "ready" }));

let config: Config | undefined;

/** src/node.ts reads config.yaml from disk and injects it (no node:fs in core). */
export function useConfig(injected: Config): void {
  config = injected;
}

// Loaded on the first gateway request, then memoized: on Workers the env
// bindings that ${VAR} resolves against exist only per-request, so config
// cannot be loaded at module scope. No reload — restart to pick up changes.
async function resolveConfig(env: Record<string, string | undefined>): Promise<Config> {
  return (config ??= loadConfig((await import("../config.yaml")).default, env));
}

// Gateway entry. Auth and the catalog routes are mounted on this same app
// rather than dispatched into a sub-app: a nested fetch() would build a second
// Hono context, and the principal, namespace and backend set downstream would
// never reach requestLogger or metricsMiddleware above (SPEC §13, §14).
app.use("/v1/*", async (c, next) => {
  const path = parseGatewayPath(new URL(c.req.url).pathname);
  if (!path) {
    const error = { message: "malformed percent-encoding in request path", type: "BadRequestException", code: 400 };
    return c.json({ error }, 400);
  }
  c.set("path", path);
  c.set("config", await resolveConfig(c.env as Record<string, string | undefined>));
  await next();
});
app.use("/v1/*", authMiddleware);
app.route("/", catalogRoutes);

export default app;
