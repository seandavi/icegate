# icegate explorer

A static, client-only browser for Iceberg REST catalogs served through
[icegate](../README.md). No build step, no server code — plain ES modules
served as-is by Cloudflare Workers Static Assets. It reads catalog metadata
(namespaces, tables, schemas, snapshots) directly from the REST API, and can
optionally run read-only SQL against table data in-browser via DuckDB-WASM.

## Run locally

From this directory:

```sh
npx wrangler dev
```

or serve `public/` with any static file server (e.g. `npx serve public`).

## Adding a catalog

Add an entry to `public/catalogs.json`:

```json
{
  "id": "mycatalog",
  "label": "My Catalog",
  "endpoint": "https://icegate-mycatalog.example.workers.dev",
  "warehouse": "mycatalog",
  "description": "One-line description shown on the directory page."
}
```

It appears as a card on the landing page and in the header catalog switcher.

To browse a catalog that isn't in the registry, without editing the file,
point at it directly:

```
?endpoint=https://your-icegate-worker.example.com&warehouse=your_warehouse
```

or use the "custom endpoint" form on the directory page — it remembers what
you enter in `localStorage` for next time.

## CORS requirement

The browser talks to the catalog endpoint directly, so it must send CORS
headers allowing your origin (or `*`). icegate does this. A raw R2/S3 bucket
put behind DuckDB-WASM's data reads generally does not, unless its bucket CORS
policy is configured for it — the Query and Analyze features will report an
error rather than break the rest of the page if that fails.

## What v1 deliberately does not do

Per [issue #37](https://github.com/seandavi/icegate/issues/37):

- No writes — read-only browsing and read-only ad-hoc SQL only.
- No row preview outside the Query tab (no default "sample rows" view).
- No cross-catalog query — one catalog attached (as `cat`) at a time.
- No recursion into child namespaces — `/namespaces` lists only top-level
  namespaces; nested namespaces aren't shown.
