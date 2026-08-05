import { Hono } from "hono";
import { authMiddleware } from "./auth/index.js";
import { type Config, loadConfig } from "./config/index.js";
import { requestLogger } from "./logging/index.js";
import { metricsMiddleware } from "./metrics/index.js";
import { catalogRoutes } from "./routing/routes.js";

const app = new Hono();

app.use("*", metricsMiddleware);
app.use("*", requestLogger);

app.get("/health", (c) => c.json({ status: "ok" }));
app.get("/ready", (c) => c.json({ status: "ready" }));

let injected: Config | undefined;

/** src/node.ts reads config.yaml from disk and injects it (no node:fs in core). */
export function useConfig(config: Config): void {
  injected = config;
}

let gateway: Hono | undefined;

// Built on the first gateway request, then memoized: on Workers the env
// bindings that ${VAR} resolves against exist only per-request, so config
// cannot be loaded at module scope. No reload — restart to pick up changes.
async function gatewayRoutes(env: Record<string, string | undefined>): Promise<Hono> {
  if (!gateway) {
    const config = injected ?? loadConfig((await import("../config.yaml")).default, env);
    gateway = new Hono();
    gateway.use("*", authMiddleware(config));
    gateway.route("/", catalogRoutes(config));
  }
  return gateway;
}

app.all("/v1/*", async (c) => {
  const routes = await gatewayRoutes(c.env as Record<string, string | undefined>);
  return routes.fetch(c.req.raw, c.env);
});

export default app;
