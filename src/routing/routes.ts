import { Hono } from "hono";
import { forward } from "../proxy/index.js";
import { buildBackendUrl, type ConfigBody, resolveCatalog, transformConfigResponse } from "./index.js";

function notFound(message: string) {
  return Response.json({ error: { message, type: "NotFoundException", code: 404 } }, { status: 404 });
}

/**
 * The Iceberg REST routes (SPEC §10): `GET /v1/config?warehouse=<name>` hands
 * the client a prefix, and every later request carries it as the first path
 * segment after `/v1/`.
 *
 * Mounted on the main app behind the `/v1/*` chain (src/index.ts), so config
 * and the resolved backend travel in the shared request context.
 */
export const catalogRoutes = new Hono();

catalogRoutes.get("/v1/config", async (c) => {
  const warehouse = c.req.query("warehouse");
  const catalog = warehouse ? resolveCatalog(c.get("config"), warehouse) : null;
  if (!catalog) return notFound(`unknown warehouse: ${warehouse ?? "(missing)"}`);
  c.set("backend", catalog.name);

  const url = buildBackendUrl(catalog, "config", new URLSearchParams({ warehouse: catalog.backend_warehouse }));
  const response = await forward(c.req.raw, url, catalog);
  if (response.status !== 200) return response;

  const body = transformConfigResponse((await response.json()) as ConfigBody, catalog.name, new URL(c.req.url).origin);
  return c.json(body);
});

catalogRoutes.all("/v1/:prefix/*", (c) => {
  const prefix = c.req.param("prefix");
  const catalog = resolveCatalog(c.get("config"), prefix);
  if (!catalog) return notFound(`unknown catalog prefix: ${prefix}`);
  c.set("backend", catalog.name);

  // Raw pathname, never c.req.path: Iceberg encodes multipart namespaces with
  // %1F separators, which must reach the backend still encoded.
  const url = new URL(c.req.url);
  const rest = url.pathname.slice(`/v1/${catalog.name}/`.length);
  return forward(c.req.raw, buildBackendUrl(catalog, rest, url.search), catalog);
});
