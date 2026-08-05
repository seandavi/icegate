import type { Config } from "./config/index.js";

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
    /** Authenticated principal name (SPEC §8). */
    principal: string;
    /** Namespace the request is scoped to, or null when the path has none (SPEC §9). */
    namespace: string | null;
    /** Public catalog name the request resolved to (SPEC §10). */
    backend: string;
  }
}
