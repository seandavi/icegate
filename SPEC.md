# Engineering Specification

## icegate

### A stateless edge gateway for Apache Iceberg REST Catalogs

Version 0.1
Status: Draft

---

# 1. Purpose

## Problem

Apache Iceberg REST Catalogs are becoming the standard interoperability layer for modern data lakehouses.

However, existing catalog implementations assume they are the public API.

Organizations often require:

* API key authentication
* OAuth
* rate limiting
* routing to multiple catalogs
* observability
* stable public endpoints
* infrastructure independence

without replacing or modifying the underlying catalog.

The gateway solves this problem.

---

## Mission

icegate is a lightweight, stateless reverse proxy for Apache Iceberg REST Catalogs.

Its purpose is to expose one or more backend catalogs through a stable public endpoint while remaining completely transparent to Iceberg clients.

It is **not** a catalog.

It is **not** a metadata store.

It is **not** a governance platform.

---

# 2. Design Principles

1. Stateless
2. Configuration-driven
3. Cloud-native
4. Edge deployable
5. Iceberg-transparent
6. Backend agnostic
7. Zero persistent state
8. Minimal dependencies

---

# 3. Non-goals

The project MUST NOT

* implement Iceberg metadata
* understand manifests
* parse Parquet
* execute SQL
* cache tables
* become another catalog
* expose proprietary APIs

---

# 4. High-Level Architecture

```text
                 DuckDB
              PyIceberg
                 Spark
                 Trino

                    │

              HTTPS REST

                    │

              icegate

         Authentication
         Authorization
         Routing
         Logging

                    │

        Iceberg REST Catalog

                    │

      Cloudflare R2
      Polaris
      Nessie
      Lakekeeper
      Glue
      Unity Catalog
```

---

# 5. Supported Backends

Initial release

* Cloudflare R2 Catalog
* Generic Iceberg REST Catalog

Future

* Polaris
* Lakekeeper
* Nessie

No backend-specific code unless absolutely required.

---

# 6. Configuration

Single YAML file.

Example:

```yaml
server:
  # Node.js target only; ignored on Cloudflare Workers,
  # where the platform owns the listener.
  host: 0.0.0.0
  port: 8787

cors:
  enabled: true
  origins:
    - "*"

authentication:

  anonymous:
    enabled: true

  api_keys:
    enabled: true

catalogs:

  omicidx:

    # Base URI including any path the backend serves under.
    # R2 Data Catalog: https://catalog.cloudflarestorage.com/<account_id>/<bucket>
    endpoint: https://catalog.cloudflarestorage.com/${CF_ACCOUNT_ID}/omicidx

    # Warehouse value the backend expects on GET /v1/config.
    # R2 Data Catalog: <account_id>_<bucket>
    backend_warehouse: ${CF_ACCOUNT_ID}_omicidx

    # Iceberg prefix the backend expects after /v1/ (single path
    # segment, no slashes). R2 Data Catalog returns a stable per-catalog
    # UUID as `overrides.prefix` in its /v1/config response — discover it
    # once with an authenticated GET and set it here.
    backend_prefix: ${R2_CATALOG_PREFIX}

    auth:
      bearer_token: ${CF_API_TOKEN}

    capabilities:

      read: true
      write: false
```

Environment interpolation: `${VAR}` anywhere in a string value is
replaced from the environment at startup. A referenced variable that is
unset fails startup. Unknown configuration keys are rejected.

---

# 7. Request Processing

The implementation is organized as a fixed middleware pipeline, much
like Caddy or modern web frameworks. Each middleware has exactly one
responsibility and communicates through a typed request context. There
are **no plugins** — the chain is compiled into the application.

```text
Request
   │
Logging & metrics (wrap the whole chain)
   │
CORS (before auth — §11 browser preflights carry no Authorization)
   │
Path parse (once, from the raw pathname)
   │
Authentication + Authorization (one middleware)
   │
Routing
   │
Request rewrite (rare)
   │
Backend transport
   │
Response rewrite (rare)
   │
Response
```

No additional processing.

---

# 8. Authentication

Supported

* Anonymous
* API Key
* Bearer Token

Future

* OAuth2
* GitHub
* Google
* ORCID

Authentication MUST be pluggable by configuration, but not by code plugins.

## API keys

* Format: `icegate_` + 32 characters of base62 randomness.
* Presented as `Authorization: Bearer <key>` — every Iceberg client
  already supports setting a static bearer token; no custom header.
* Config stores only SHA-256 hex digests, keyed by principal name
  (Section 9), so the YAML is committable. Plaintext exists only at
  issuance.
* Authentication: hash the presented bearer value, compare against
  configured digests. No match → 401.
* The client-facing bearer value is never forwarded; the gateway
  attaches the backend catalog's own credentials (Section 6).

---

# 9. Authorization

Permissions

* catalog
* namespace
* read
* write

Example

```yaml
api_keys:

  alice:

    sha256: 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08

    namespaces:

      - geo

      - tcga

    permissions:

      - read

anonymous:

  namespaces:

    - geo

  permissions:

    - read
```

## Multipart namespaces

Iceberg encodes a multipart namespace as a single path segment whose
levels are joined by the unit separator `0x1F` (`geo%1Fsub`). The
gateway decodes that segment exactly once and scopes authorization on
its **top-level** namespace, so a principal granted `geo` also reaches
`geo.sub`; the segment is forwarded to the backend still encoded. A
segment carrying malformed percent-encoding is a 400 (Section 15).

## Read vs write classification

`read` and `write` are enforced per REST operation, not per HTTP
method (Iceberg REST uses POST for some read operations):

* **read** — all GET and HEAD requests; POST scan planning
  (`.../plan`, `.../tasks`); POST metrics reporting (`.../metrics`)
* **write** — everything else (create/update/drop/rename namespace or
  table, commit, register, view and transaction endpoints)

---

# 10. Routing

Routing uses the mechanism built into the Iceberg REST protocol: the
`warehouse` parameter and the `prefix` path segment.

1. A client session begins with `GET /v1/config?warehouse=<name>`.
   The gateway looks up `<name>` in `catalogs` and responds with
   `overrides.prefix = <name>`. Unknown warehouse → 404.
2. The client places that prefix in every subsequent path:
   `/v1/<name>/namespaces/...`. The gateway resolves the backend with a
   dictionary lookup on the first path segment after `/v1/`.
3. The gateway strips the public prefix from the path and forwards to
   `<endpoint><backend_prefix?>/v1/<rest>`. The backend's base URI may
   itself contain path segments, which precede `/v1` — R2 Data Catalog
   serves at
   `https://catalog.cloudflarestorage.com/<account_id>/<bucket>/v1/...`.
   `backend_prefix`, when non-empty, is inserted after `/v1/` per the
   Iceberg REST prefix convention. Public prefixes MUST be a single
   path segment: some clients (DuckDB) split a prefix on `/` into
   components.

Namespaces play no role in routing; they are used only for
authorization (Section 9). Because every request identifies exactly one
backend, endpoints without a namespace in the path (`/v1/config`,
list-namespaces) route unambiguously — no fan-out or merging.

No regex. No first-match-wins rules.

---

# 11. Request and Response Transformation

Only the following transformations are permitted.

* Request paths: public prefix stripped, joined to the backend base
  URI (Section 10); forwarded requests carry the backend host's `Host`
  header (backends reject a foreign Host)
* `/v1/config` requests: rewrite `?warehouse=<name>` to the catalog's
  configured `backend_warehouse`
* `/v1/config` responses: set `overrides.prefix` to the public prefix;
  set `overrides.uri` to the gateway's public endpoint and DELETE any
  `defaults.uri`. Both are required: PyIceberg merges defaults and
  overrides and re-reads `uri` from the result, and DuckDB reads
  `overrides.uri` — a backend-supplied `uri` in either map causes
  clients to abandon the gateway and address the backend directly.
  Any `endpoints` list MUST be forwarded unchanged.
* Location headers: backend prefix → public prefix

All other payloads MUST be forwarded unchanged. In particular, storage
credentials vended by the backend (Section 12) MUST NOT be modified or
stripped.

CORS: when enabled, the gateway answers OPTIONS preflight requests and
adds the configured CORS headers to responses. Required for browser
clients (e.g., DuckDB-WASM).

---

# 12. Storage

The gateway SHALL NOT proxy object storage.

The gateway SHALL NOT proxy Parquet reads.

Clients reach object storage via **credential vending**, which the
backend catalog already implements:

1. The client sends `X-Iceberg-Access-Delegation: vended-credentials`.
   PyIceberg and DuckDB send it by default. Spark (Iceberg Java REST
   client) and Trino do **not** — the operator must configure it:
   Spark via the catalog property
   `header.X-Iceberg-Access-Delegation=vended-credentials`, Trino via
   `iceberg.rest-catalog.vended-credentials-enabled=true` (note:
   Cloudflare's documented Trino setup instead uses static R2 S3 keys,
   so Trino users of an anonymous catalog must supply their own
   object-storage credentials). The gateway cannot force clients to
   request vended credentials; it only forwards the header and the
   resulting credentials unchanged.
2. The gateway MUST forward this header unchanged.
3. The backend returns temporary, table-scoped storage credentials in
   the `loadTable` response; the gateway MUST forward them unchanged.
4. The client reads data files directly from storage. No bytes of table
   data ever pass through the gateway.

"Public" data is therefore anonymous *catalog* access plus vended
credentials — no URL rewriting.

Remote signing is NOT supported through the gateway: R2's config
response carries an absolute `s3.signer.uri` on the backend host, and
signing requests there require backend credentials the client does not
hold. Clients behind the gateway use vended credentials (Cloudflare's
own client recipes set `s3.remote-signing-enabled=false`).

Operational requirement: a catalog exposed to anonymous users MUST be
configured with a backend token that is read-only on BOTH the catalog
and the object store. For R2 Data Catalog that means `Workers R2 Data
Catalog Read` AND `Workers R2 Storage Read` (dashboard: "Admin Read
only"). Catalog-read-only with storage-read-write is NOT sufficient:
vended credentials inherit the token's storage permissions, so such a
token can still write objects — including catalog metadata files —
directly to the bucket. `capabilities.write: false` blocks commits at
the REST layer only.

Blast radius: R2's catalog permission groups are account-scoped and
cannot be restricted to a single bucket. A token configured for one
warehouse can read every R2 Data Catalog in that Cloudflare account.
Isolate exposure boundaries by Cloudflare account.

---

# 13. Logging

Structured JSON.

Each request

* timestamp
* request id
* client ip
* authenticated user
* namespace
* backend
* status
* latency

No Iceberg metadata logged.

---

# 14. Metrics

Prometheus endpoint — **Node.js target only**. Cloudflare Workers
isolates are ephemeral and unaggregated, so an in-memory `/metrics`
endpoint would be meaningless there; on Workers, observability is
structured logs (Section 13) plus platform analytics.

Required metrics

```
requests_total

request_duration_seconds

backend_errors_total

auth_failures_total

active_requests
```

---

# 15. Errors

Backend status codes should be preserved whenever possible.

Gateway-generated errors

400

401

403

404

500

502

503

---

# 16. Health Endpoints

```
GET /health

GET /ready

GET /metrics   (Node.js target only, Section 14)
```

---

# 17. Deployment Targets

Primary

Cloudflare Workers

Secondary

Node.js

Optional

Docker

No Kubernetes assumptions.

Single codebase written against the standard `fetch` handler interface
(`Request → Response`). Workers runs it natively; Node.js runs it via a
thin adapter. No runtime-specific APIs in core code.

---

# 18. Performance Goals

Median gateway overhead (added latency, excluding backend time)

<10 ms

Memory

<128 MB

Cold start

<100 ms

Stateless.

Horizontally scalable.

---

# 19. Acceptance Tests

## Configuration

✓ Invalid YAML fails startup

✓ Unknown keys rejected

✓ Missing backend credentials detected

---

## Transparency

Using DuckDB

```
ATTACH ...
TYPE ICEBERG;
```

must work.

No custom code.

---

PyIceberg

```
load_catalog()
```

works unchanged.

---

Spark

Catalog loads.

---

Trino

Catalog loads.

---

## Routing

`GET /v1/config?warehouse=omicidx` returns `overrides.prefix = omicidx`.

Requests under `/v1/omicidx/...` reach the configured backend with the
backend prefix substituted.

Unknown warehouse or prefix returns 404.

---

## Authentication

Anonymous public namespace succeeds.

Anonymous private namespace fails.

Bad API key → 401

Valid API key → success

---

## Backend Failure

Backend timeout

↓

Gateway returns 502

---

## Statelessness

Multiple gateway instances produce identical responses.

No local filesystem writes.

---

## Performance

100 concurrent requests

No failures.

Median latency target achieved.

---

# 20. Project Structure

```
src/

    auth/

    config/

    routing/

    proxy/

    metrics/

    logging/

tests/

examples/

docs/
```

---

# 21. Future Roadmap (Explicitly Out of Scope for v1)

* OAuth/OIDC providers
* Dynamic configuration reload
* Rate limiting (needs platform state, e.g. Workers rate-limit
  bindings or a shared counter; stateless v1 cannot do it honestly)
* Multi-region failover
* Backend health-aware routing
* Catalog discovery API
* Administrative UI
* Web-based API key management
* Fine-grained policy engine (e.g., Open Policy Agent integration)
* Credential-free public HTTP access to table data (a writer-side
  concern — metadata must be written with public custom-domain URLs;
  the gateway cannot retrofit this because manifests in object storage
  carry baked-in URIs it never serves)


