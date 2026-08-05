import { backendBase, type Catalog } from "../routing/index.js";

// Connection-specific headers that MUST NOT be forwarded (RFC 9110 §7.6.1).
const HOP_BY_HOP = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  // fetch() sets Host from the target URL; backends reject a foreign Host (SPEC §11).
  "host",
];

/**
 * Forwards a client request to `url` with the catalog's own credentials.
 * The client-facing bearer value is never passed through (SPEC §8); every
 * other header, notably `X-Iceberg-Access-Delegation`, goes untouched.
 *
 * Error mapping, timeouts and CORS are ticket #10 — this is transport only.
 */
export async function forward(request: Request, url: string, catalog: Catalog): Promise<Response> {
  const headers = new Headers(request.headers);
  for (const name of HOP_BY_HOP) headers.delete(name);
  headers.set("Authorization", `Bearer ${catalog.auth.bearer_token}`);

  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const response = await fetch(url, {
    method: request.method,
    headers,
    body: hasBody ? request.body : undefined,
    redirect: "manual",
    // Required when streaming a request body; not in the DOM lib's RequestInit.
    ...(hasBody ? { duplex: "half" } : {}),
  } as RequestInit);

  const location = response.headers.get("location");
  if (!location) return response;

  const rewritten = rewriteLocation(location, catalog, new URL(request.url).origin);
  if (rewritten === location) return response;

  const out = new Response(response.body, response);
  out.headers.set("Location", rewritten);
  return out;
}

// ponytail: absolute and backend-relative Locations only. A root-relative
// Location (/v1/<backend_prefix>/...) resolves against the backend origin and
// so only matches when the endpoint has no extra path segments — R2 returns
// absolute URLs. Widen if a backend turns up that doesn't.
function rewriteLocation(location: string, catalog: Catalog, gatewayOrigin: string): string {
  const base = backendBase(catalog);
  const absolute = new URL(location, base).toString();
  if (!absolute.startsWith(base)) return location;
  return `${gatewayOrigin}/v1/${catalog.name}/${absolute.slice(base.length)}`;
}
