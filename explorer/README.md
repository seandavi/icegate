# icegate explorer

A static, client-only browser for Apache Iceberg REST catalogs: a
warehouse → namespace → table tree, per-table schema with live column
statistics, real snapshot history, and read-only SQL — all running in the
browser.

No build step, no server code, no dependencies. Plain ES modules served as-is
by Cloudflare Workers Static Assets. It reads catalog metadata straight from
the REST API, and loads DuckDB-WASM from a CDN only when you ask it to run a
query. Nothing you browse is sent anywhere except to the catalog itself.

It is **not** icegate-specific. Any standards-compliant Iceberg REST catalog
that meets the two requirements below will work.

## Run locally

From this directory:

```sh
npx wrangler dev          # serves exactly as the deployed Worker does
```

or serve `public/` with any static file server. Note that Workers Static
Assets redirects `/index.html` to `/`, so use the bare root.

Deploy (its own Worker, `icegate-explorer`):

```sh
npm run deploy:explorer   # from the repo root
```

## Using it with any Iceberg REST catalog

Point it at a catalog without touching the registry:

```
?endpoint=https://catalog.example.com&warehouse=my_warehouse
```

or use the **custom endpoint** form on the directory page, which remembers
what you type in `localStorage`.

### Two requirements

**1. The catalog must allow anonymous reads.** The explorer sends no
`Authorization` header, ever — there is nowhere safe to put a credential in a
static page that anyone can view source on. A catalog that requires a token
will return 401 and the page will say so.

If your catalog needs credentials, that is exactly the gap
[icegate](../README.md) fills: it holds the backend credential server-side and
can expose a namespace-scoped anonymous view of the catalog. Point the
explorer at the gateway rather than at the catalog.

**2. The catalog must send CORS headers.** A browser will not read a
cross-origin API that does not opt in. See [CORS](#cors) below.

### Finding the right `warehouse` value

The explorer builds request paths as `<endpoint>/v1/<warehouse>/namespaces`.
In the REST spec that path segment is the **prefix**, which a catalog
advertises in its config response — and it is not always the same string as
the warehouse name. Ask the catalog:

```sh
curl -s "https://catalog.example.com/v1/config?warehouse=my_warehouse" | jq .overrides.prefix
```

Use whatever that returns as the `warehouse` value here. For icegate the
prefix is the catalog name, so the two are identical and there is nothing to
look up. Other implementations may return a UUID or a differently-shaped
identifier; if the tree loads but every namespace 404s, this is the reason.

### What works where

| | Browse (tree, schema, history) | Query / Analyze |
| --- | --- | --- |
| icegate-fronted catalog, bucket CORS configured | ✅ Verified | ✅ Verified |
| icegate-fronted catalog, bucket CORS missing | ✅ Verified | ❌ Fails with a CORS error, page stays usable |
| Any anonymous, CORS-enabled REST catalog | 🟡 Per spec, not exercised by our tests | 🟡 Also needs object-store CORS and anonymous object reads |
| Catalog requiring a bearer token | ❌ Not supported by design | ❌ |

Browsing and querying are independent: a catalog whose object storage blocks
browsers is still fully browsable. Only the Query tab and the Schema tab's
Analyze button need to reach the data files.

## CORS

There are **two separate layers**, and they fail differently. Getting the
first right does not give you the second.

### Layer 1 — the catalog endpoint

Needed for everything. Without it the page cannot list namespaces at all.

icegate does this for you; enable it in the gateway's config:

```yaml
cors:
  enabled: true
  origins: ["*"]
```

Check it:

```sh
curl -sD- -o /dev/null -H "Origin: https://example.com" \
  "https://catalog.example.com/v1/config?warehouse=my_warehouse" | grep -i access-control
```

You want an `access-control-allow-origin` header back.

### Layer 2 — the object store

Needed only for Query and Analyze. DuckDB-WASM reads Parquet and Avro files
directly from object storage, so the **bucket** must also allow browser reads.
A raw R2 or S3 bucket does not by default, and no amount of gateway config
changes that — the gateway is not in that request path.

The symptom is specific and misleading: DuckDB reports a **404 on a `.avro`
manifest**, because the browser hands it a blocked response with the real
status hidden.

```
HTTP Error: Full download failed to URL ".../metadata/snap-….avro": 404
(Please consult the browser console for details, might be potentially a CORS error)
```

That is a CORS failure, not a missing file. Confirm by preflighting the bucket
directly — a working bucket answers `204` with `access-control-*` headers, a
misconfigured one answers `403` with none:

```sh
curl -sD- -o /dev/null -X OPTIONS \
  -H "Origin: https://icegate-explorer.example.workers.dev" \
  -H "Access-Control-Request-Method: GET" \
  -H "Access-Control-Request-Headers: authorization,x-amz-content-sha256,x-amz-date" \
  "https://<account>.r2.cloudflarestorage.com/<bucket>/" | grep -iE "^HTTP|access-control"
```

Fix it by putting this policy on the bucket — these are the exact values a
working bucket in this project serves, committed as
[`r2-cors.json`](r2-cors.json):

```json
{
  "rules": [
    {
      "allowed": { "origins": ["*"], "methods": ["GET", "HEAD"], "headers": ["*"] },
      "exposeHeaders": ["ETag", "Content-Length", "Content-Range", "Accept-Ranges"],
      "maxAgeSeconds": 3600
    }
  ]
}
```

```sh
npx wrangler r2 bucket cors set <bucket> --file explorer/r2-cors.json
npx wrangler r2 bucket cors list <bucket>    # confirm
```

Two parts of that are easy to get wrong and both break Query in ways the error
message does not explain:

- **`exposeHeaders` is not optional.** DuckDB-WASM reads Parquet with HTTP
  range requests, so the browser has to let it *see* `Content-Range` and
  `Accept-Ranges` on the response. Allowing the request without exposing these
  gets you a preflight that passes and reads that fail.
- **`GET` and `HEAD` are all that belong there.** This is a read-only page;
  the bucket should not let a browser do anything else.

Note that a preflight response echoes back whatever headers the caller asked
for, so `Access-Control-Allow-Headers` in a `curl` result tells you what you
requested, not what the bucket policy says. Read the policy itself with
`wrangler r2 bucket cors list`.

### Known status

| Catalog | Layer 1 (catalog) | Layer 2 (bucket) |
| --- | --- | --- |
| `canceronice` | ✅ | ✅ |
| `bioconice` | ✅ | ✅ |

## Adding a catalog to the registry

Registry entries appear as cards on the landing page and in the header
switcher. Add one to `public/catalogs.json`:

```json
{
  "id": "mycatalog",
  "label": "My Catalog",
  "endpoint": "https://catalog.example.com",
  "warehouse": "mycatalog",
  "description": "One line, shown on the directory card."
}
```

`endpoint` takes no `/v1` and no trailing slash. See above on what `warehouse`
must be. A catalog that fails to respond shows as "unreachable" on its card
without affecting the others.

## What v1 deliberately does not do

Per [issue #37](https://github.com/seandavi/icegate/issues/37):

- **No writes.** Read-only browsing and read-only SQL, matching icegate's own
  anonymous-read design.
- **No authenticated catalogs** — see above.
- **No row-data preview** outside the Query tab.
- **No cross-catalog query.** DuckDB-WASM can attach several catalogs at once,
  which is appealing for a page whose premise is browsing a set of them, but
  it is v2.
- **No recursion into child namespaces.** `/namespaces` returns only
  top-level namespaces; nested ones are not walked. Multi-level namespaces are
  handled correctly everywhere else.
- **No search beyond the sidebar filter**, which matches namespace and table
  names already loaded. Searching column names or documentation would mean a
  `LoadTable` call per table, which wants a prebuilt index rather than
  live fan-out.

## Working on it

Read [CONTRACT.md](CONTRACT.md) first. It records the seams between the four
modules — the namespace forms, the int64 id handling, the class contract, and
where each piece of state lives. Every integration bug this app has had came
from two authors assuming different things about one of them.
