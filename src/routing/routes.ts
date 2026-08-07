import type { Context } from "hono";
import { Hono } from "hono";
import { errorResponse } from "../errors.js";
import { forward } from "../proxy/index.js";
import {
  backendConfigUrl,
  buildBackendUrl,
  type Catalog,
  type ConfigBody,
  resolveCatalog,
  transformConfigResponse,
} from "./index.js";

/**
 * The Iceberg REST routes (SPEC §10): `GET /v1/config?warehouse=<name>` hands
 * the client a prefix, and every later request carries it as the first path
 * segment after `/v1/`.
 *
 * Mounted on the main app behind the `/v1/*` chain (src/index.ts), so config
 * and the resolved backend travel in the shared request context.
 *
 * Both routes reach the backend through `proxy` below. They used to forward
 * separately and drifted apart — one dropped query parameters, one re-encoded
 * the body — so there is one forward path and only `/v1/config` adds a
 * response transform on top of it (SPEC §11).
 */
export const catalogRoutes = new Hono();

catalogRoutes.get("/v1/config", async (c) => {
  const warehouse = c.req.query("warehouse");
  const catalog = warehouse ? resolveCatalog(c.get("config"), warehouse) : null;
  if (!catalog) return notFound(`unknown warehouse: ${warehouse ?? "(missing)"}`);

  // Only `warehouse` is rewritten (SPEC §11); anything else the client sent
  // rides along untouched.
  const query = new URL(c.req.url).searchParams;
  query.set("warehouse", catalog.backend_warehouse);

  const response = await proxy(c, catalog, backendConfigUrl(catalog, query));
  if (response.status !== 200) return response;

  const body = transformConfigResponse((await response.json()) as ConfigBody, catalog.name, new URL(c.req.url).origin);
  return replaceJsonBody(response, body);
});

catalogRoutes.all("/v1/:prefix/*", (c) => {
  // `rest` comes off the raw pathname (src/context.ts), so Iceberg's %1F
  // namespace separators reach the backend still encoded.
  const { prefix, rest } = c.get("path");
  const catalog = resolveCatalog(c.get("config"), prefix);
  if (!catalog) return notFound(`unknown catalog prefix: ${prefix}`);

  return proxy(c, catalog, buildBackendUrl(catalog, rest, new URL(c.req.url).search));
});

function notFound(message: string) {
  return errorResponse(404, "NotFoundException", message);
}

/** Records the resolved backend (SPEC §13/§14) and forwards. */
function proxy(c: Context, catalog: Catalog, url: string): Promise<Response> {
  c.set("backend", catalog.name);
  return forward(c.req.raw, url, catalog, c.get("canWrite") ?? false);
}

/**
 * Swaps in a rewritten JSON body, keeping the backend's status and headers —
 * only the transformations SPEC §11 lists may change. The two headers that
 * describe the *old* bytes have to go.
 */
function replaceJsonBody(response: Response, body: unknown): Response {
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  return new Response(JSON.stringify(body), { status: response.status, headers });
}
