import { errorResponse } from "../errors.js";
import { backendBase, type Catalog } from "../routing/index.js";

// ponytail: a constant, not config — no deployment has asked for a different
// value, and Workers caps a request at well under this anyway. Promote to
// config the day one does.
const UPSTREAM_TIMEOUT_MS = 30_000;

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
 * Forwards a client request to `url` with the catalog's own credentials:
 * `bearer_token_write` when the principal holds `write` and the catalog
 * configures one, `bearer_token` otherwise — so the read token is the
 * default a bug falls back to, not the write token (SPEC §12, issue #34).
 * The client-facing bearer value is never passed through (SPEC §8); every
 * other header, notably `X-Iceberg-Access-Delegation`, goes untouched, and so
 * does the backend's response — status included (SPEC §11, §15).
 *
 * A backend that times out, refuses the connection or drops it becomes a 502:
 * SPEC §19 names 502 for the backend-failure case, and all three are the same
 * failure to a client. 503 stays reserved for the gateway's own unavailability.
 */
export async function forward(request: Request, url: string, catalog: Catalog, canWrite = false): Promise<Response> {
  const headers = new Headers(request.headers);
  for (const name of HOP_BY_HOP) headers.delete(name);
  const token = canWrite ? (catalog.auth.bearer_token_write ?? catalog.auth.bearer_token) : catalog.auth.bearer_token;
  headers.set("Authorization", `Bearer ${token}`);

  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  let response: Response;
  try {
    response = await fetch(url, {
      method: request.method,
      headers,
      body: hasBody ? request.body : undefined,
      redirect: "manual",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      // Required when streaming a request body; not in the DOM lib's RequestInit.
      ...(hasBody ? { duplex: "half" } : {}),
    } as RequestInit);
  } catch (err) {
    const cause = (err as Error).name === "TimeoutError" ? `timed out after ${UPSTREAM_TIMEOUT_MS}ms` : "is unreachable";
    return errorResponse(502, "BadGatewayException", `backend catalog "${catalog.name}" ${cause}`);
  }

  const encoded = response.headers.has("content-encoding");
  const location = response.headers.get("location");
  const rewritten = location ? rewriteLocation(location, catalog, new URL(request.url).origin) : null;
  if (!encoded && rewritten === location) return response;

  const outHeaders = new Headers(response.headers);
  // fetch() decompresses the body but leaves the headers describing the
  // compressed bytes: a client that trusts Content-Encoding then fails to
  // gunzip plaintext. Content-Length is stale for the same reason. (Found by
  // the acceptance suite — PyIceberg and node's fetch send Accept-Encoding,
  // curl does not, so only real clients hit it.)
  if (encoded) {
    outHeaders.delete("content-encoding");
    outHeaders.delete("content-length");
  }
  if (rewritten !== null) outHeaders.set("Location", rewritten);

  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: outHeaders });
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
