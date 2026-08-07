# icegate Operator Guide

How to configure, deploy and run your own icegate instance. For client-side
usage (DuckDB, PyIceberg, Spark, Trino) see [users.md](users.md). The
normative behaviour is in [SPEC.md](../SPEC.md); this document is the
operational reading of it.

---

## 1. How it works

icegate is a stateless reverse proxy in front of one or more Iceberg REST
catalogs. It authenticates the client, authorizes the operation, resolves a
backend from the first path segment after `/v1/`, swaps the client's bearer
token for the backend catalog's own credentials, and forwards the request.
Table data never passes through it — clients read object storage directly
using credentials vended by the backend catalog. There is no database, no
cache and no local state: **the YAML config file is the only state**, it is
bundled into the build (Workers) or read from disk at startup (Node), and it
is never reloaded — to change it, redeploy or restart.

---

## 2. Configuration

One YAML file. Same schema on every runtime (`src/config/index.ts`).

### 2.1 Where the file comes from

| Runtime | Source | When it loads | On error |
| --- | --- | --- | --- |
| Cloudflare Workers | `config.yaml` at the repo root, bundled at build time by the wrangler `Text` rule in `wrangler.jsonc` | lazily, on the first `/v1/*` request, then memoized for the isolate's lifetime | that request returns 500; `/health` and `/ready` keep returning 200 |
| Node / Docker | `$ICEGATE_CONFIG`, defaulting to `config.yaml` next to the project root | at startup | the process exits non-zero |

Two consequences worth internalizing:

* On Workers the config is *baked into the deployed script*. `wrangler deploy`
  ships whatever `config.yaml` contains at that moment — `scripts/deploy.sh`
  copies `config.production.yaml` over it for exactly this reason.
* On Workers a broken config does not fail the deploy and does not fail the
  health checks. Always `curl` a real `/v1/config?warehouse=<name>` after
  deploying, not just `/health`.

### 2.2 `${VAR}` interpolation

Any `${VAR}` occurring inside any string value, at any depth, is replaced
before validation. A referenced variable that is unset is a hard error naming
both the variable and the config path. The pattern is `${NAME}` with `NAME`
matching `[A-Za-z_][A-Za-z0-9_]*`; there is no `${VAR:-default}` form and no
escaping.

Where the environment comes from:

* **Workers** — the Worker's `env` bindings: secrets set with
  `npx wrangler secret put NAME`, and plain values under `vars` in
  `wrangler.jsonc`. (`wrangler dev` reads a local `.dev.vars` file instead.)
  Not `process.env`.
* **Node / Docker** — `process.env` of the gateway process.

Keep credentials in `${VAR}`s so the YAML stays committable. Everything else
(prefixes, warehouse names, key digests) is safe to commit literally.

### 2.3 Top level

```yaml
server:          # optional — see 2.4, currently unread
cors:            # optional
authentication:  # REQUIRED
catalogs:        # REQUIRED, at least one entry
```

Every object in the schema is strict: **an unknown or misspelled key is a
startup failure**, not a warning. There is no merging of multiple files and no
include mechanism.

### 2.4 `server` (optional)

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `host` | string | yes, if `server` is present | |
| `port` | positive integer | yes, if `server` is present | |

**Both fields are currently accepted and validated but never read.** Workers
owns its own listener; the Node entry point (`src/node.ts`) binds the port from
the `PORT` environment variable, defaulting to `8787`. Set `PORT`, not
`server.port`. (Known gap, recorded on issue #13/#20 as acceptable for v1.)

### 2.5 `cors` (optional)

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `enabled` | boolean | yes, if `cors` is present | |
| `origins` | array of strings | yes, if `cors` is present | a literal `"*"` anywhere in the list turns on the wildcard |

Applies to `/v1/*` only; `/health` and `/ready` are never CORS-decorated.
Preflight is answered before authentication, so an `OPTIONS` never 401s. The
allowed methods (`GET, HEAD, POST, PUT, DELETE`) and headers
(`Authorization`, `Content-Type`, `X-Iceberg-Access-Delegation`,
`X-Request-Id`) are fixed in code and not configurable.

Omitting `cors` disables it. You need it for browser clients such as
DuckDB-WASM; R2 Data Catalog serves no CORS headers of its own, so the
gateway's are the only ones a browser will see.

### 2.6 `authentication` (required)

```yaml
authentication:
  anonymous:
    enabled: true
    namespaces: [geo]
    permissions: [read]
  api_keys:
    enabled: true
    alice:
      sha256: 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08
      namespaces: [geo, tcga]
      permissions: [read]
```

`anonymous`:

| Field | Type | Required | Default |
| --- | --- | --- | --- |
| `enabled` | boolean | yes | — |
| `namespaces` | array of strings | no | `[]` |
| `permissions` | array of `read` \| `write` | no | `[]` |

`api_keys`:

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `enabled` | boolean | yes | `false` rejects every bearer token, even if principals are listed below |
| *any other key* | principal object | no | the key is the principal name used in logs |

Principal object (all three fields required, no others allowed):

| Field | Type | Notes |
| --- | --- | --- |
| `sha256` | 64-character hex string | SHA-256 of the full API key text, see section 3 |
| `namespaces` | array of strings | top-level namespaces this principal may touch |
| `permissions` | array of `read` \| `write` | |

Behaviour to know:

* `authentication: {}` is valid and rejects everything with 401. Both
  sub-sections are optional.
* A request **with** an `Authorization: Bearer` header is only ever matched
  against API keys. An unrecognized token is 401 — it never falls back to
  anonymous.
* A request **without** the header is anonymous, or 401 if anonymous is
  disabled.
* `GET /v1/config` requires authentication but skips authorization entirely,
  so with anonymous disabled clients must present a key to bootstrap.

### 2.7 `catalogs` (required)

A map of *public prefix* → backend. The key is what clients pass as
`?warehouse=` and what appears in every later path (`/v1/<name>/...`).

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `endpoint` | string, non-empty | yes | Full backend base URI **including any path segments it serves under**. `/v1` is appended by the gateway. Trailing slashes are stripped. |
| `backend_warehouse` | string, non-empty | yes | What the gateway substitutes for `?warehouse=` when forwarding `/v1/config` |
| `backend_prefix` | string, no `/` | no | The Iceberg prefix the backend wants after `/v1/`. Inserted into every forwarded path **except** `/v1/config`, which is prefix-less by protocol. Omit or `""` if the backend has none. |
| `auth.bearer_token` | string, non-empty | yes | Sent to the backend as `Authorization: Bearer`. The default for every request — anonymous, read keys, and any path that never resolves a principal. |
| `auth.bearer_token_write` | string, non-empty | no | Sent instead of `bearer_token` when the authenticated principal holds `write`. Omit to use one token for everything. See section 6 for why you want the split. |
| `capabilities.read` | boolean | yes | |
| `capabilities.write` | boolean | yes | |

Cross-field and naming rules enforced at startup:

* at least one catalog must exist;
* a catalog name must not contain `/` (some clients, DuckDB included, split a
  prefix on `/`);
* `backend_prefix` must not contain `/`.

Not enforced but required in practice: **do not name a catalog `config`.**
`/v1/config` is the reserved protocol endpoint and shadows it.

### 2.8 How read/write and namespaces are enforced

Operation classification is per REST operation, not per HTTP method:

* **read** — all `GET` and `HEAD`; plus `POST` to a path ending in `/plan`,
  `/tasks` or `/metrics` (scan planning and metrics reporting).
* **write** — everything else.

The classified operation is checked twice: against the principal's
`permissions`, and against the catalog's `capabilities`. Either one saying no
is a 403. `capabilities` is therefore a per-catalog kill switch independent of
who is asking — but it stops writes *at the REST layer only* (see section 6).

Namespace scoping: when the path is `/v1/<catalog>/namespaces/<ns>/...`, the
`<ns>` segment is decoded once and its **top level** is compared against the
principal's `namespaces`, so a grant of `geo` also covers `geo.sub` (Iceberg
sends multipart namespaces as one segment joined by `0x1F`). Paths without a
namespace — `/v1/config`, and the list-namespaces endpoint
`/v1/<catalog>/namespaces` — carry no namespace to check, so **listing
namespaces is not filtered by grant**: a principal with `read` sees every
namespace name in the catalog, and is only blocked when it tries to descend
into one it was not granted. Treat namespace *names* as public within a
catalog.

---

## 3. API keys

Format: `icegate_` followed by 32 base62 characters, presented by clients as
`Authorization: Bearer icegate_...` — every Iceberg client already supports a
static bearer token, so no custom header is needed.

The config stores **only the SHA-256 hex digest** of the full key text
(including the `icegate_` prefix). Plaintext exists once, at issuance; give it
to the user and discard it. There is no key recovery — reissue instead.

Mint a key and its digest:

```bash
KEY=$(node -e 'const a="0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz",b=crypto.getRandomValues(new Uint8Array(32));console.log("icegate_"+[...b].map(x=>a[x%62]).join(""))')
echo "key:    $KEY"
echo "sha256: $(printf %s "$KEY" | sha256sum | cut -d' ' -f1)"   # macOS: shasum -a 256
```

Then add the principal:

```yaml
authentication:
  api_keys:
    enabled: true
    alice:
      sha256: <the digest printed above>
      namespaces: [geo, tcga]
      permissions: [read]
```

Notes:

* The digest is over the *exact* string the client sends after `Bearer `. Watch
  for trailing newlines — `printf %s`, not `echo`.
* Digest comparison is case-insensitive on the config side; the key itself is
  case-sensitive.
* Revoking a key means deleting the principal and redeploying/restarting.
  There is no revocation list and no expiry.
* The client's bearer value is never forwarded upstream; the backend only ever
  sees the catalog's own backend token — `auth.bearer_token`, or
  `auth.bearer_token_write` when the principal holds `write`.

---

## 4. Deploying to Cloudflare Workers

Prerequisites: Node, an account with Workers enabled, and a Cloudflare API
token with Workers deploy rights.

1. **Write your config.** Put the deployable YAML in `config.production.yaml`
   (or edit `config.yaml` directly). Use `${VAR}` for every secret.
2. **Deploy the script.** `npx wrangler deploy`, or `npm run deploy`. This
   bundles `config.yaml` — copy your production file over it first if you keep
   them separate.
3. **Set the secrets** that your `${VAR}`s reference:
   `printf %s "$VALUE" | npx wrangler secret put NAME`. Non-secret values can
   instead go in `vars` in `wrangler.jsonc`.
4. **Verify** with a real request, not just `/health`:
   `curl https://<worker>.workers.dev/v1/config?warehouse=<catalog>`.

Ordering note: `wrangler secret put` refuses a script that does not exist yet,
so the first deploy must precede the first secret. Between the two there is a
window in which `/v1/*` returns 500 — config resolution is lazy, so no
already-served request is affected, and the next request after the secrets land
succeeds.

`scripts/deploy.sh` automates all of this for the reference (omicidx)
deployment: it pulls the account id and Cloudflare API token from Google Secret
Manager (`cdsci-infra` project), discovers the R2 catalog's UUID prefix from
the backend's own `/v1/config`, swaps `config.production.yaml` into place (and
restores `config.yaml` on exit), deploys, then pushes `CF_ACCOUNT_ID`,
`R2_BUCKET`, `CF_API_TOKEN_RO`, `CF_API_TOKEN_RW` and `R2_CATALOG_PREFIX` as
Workers secrets (the token pair is minted once by
`scripts/create-backend-tokens.sh` — see section 6). It is
specific to that project's secret store — read it as a worked example and
substitute your own source of values. Redeploying is simply rerunning it.

`wrangler dev` runs the same code locally against `config.yaml`, with `${VAR}`
resolved from `.dev.vars`. The committed `config.yaml` is deliberately free of
`${VAR}` references so `wrangler dev` starts with an empty environment.

`wrangler.jsonc` needs two things beyond the defaults, both already present:
`compatibility_flags: ["nodejs_compat"]`, and the `Text` rule that makes
`*.yaml` importable as a string module. Removing either breaks the build.

---

## 5. Deploying on Node and Docker

Same code, different entry point (`src/node.ts`): it reads the config from disk
at startup and injects it, then serves with `@hono/node-server`.

```bash
npm ci
ICEGATE_CONFIG=/etc/icegate/config.yaml PORT=8787 npm run start:node
```

`ICEGATE_CONFIG` defaults to `config.yaml` at the project root. `PORT` defaults
to `8787`. `${VAR}`s resolve from the process environment. A bad config exits
non-zero at startup — Node fails fast where Workers fails on first request.

Docker: the provided `Dockerfile` is `node:22-slim`, installs with `npm ci`,
copies `src/` and a `config.yaml`, exposes 8787 and runs `npx tsx src/node.ts`.
Mount your real config and point `ICEGATE_CONFIG` at it:

```bash
docker build -t icegate .
docker run -p 8787:8787 \
  -v /etc/icegate/config.yaml:/config.yaml:ro \
  -e ICEGATE_CONFIG=/config.yaml \
  -e CF_ACCOUNT_ID=... -e CF_API_TOKEN_RO=... -e CF_API_TOKEN_RW=... \
  icegate
```

Endpoints by target:

| Endpoint | Workers | Node/Docker | Auth |
| --- | --- | --- | --- |
| `GET /health` | yes | yes | none |
| `GET /ready` | yes | yes | none |
| `GET /metrics` | **no** | yes | **none** |

`/health` and `/ready` are static 200s that do not touch config or the backend
— they are liveness signals for the process, not for the catalog behind it.
`/metrics` is Node-only by design (Workers isolates are ephemeral and
unaggregated, so in-process counters there would be meaningless) and it is
**unauthenticated** — the auth middleware is mounted on `/v1/*` only. Do not
expose it publicly; bind it behind your own ingress or firewall.

The gateway is stateless and writes nothing to disk, so scale it by running
more copies. Each copy keeps its own metric counters.

---

## 6. Fronting a Cloudflare R2 Data Catalog

R2 Data Catalog puts the account and bucket in the **base URI, before `/v1`** —
not in the Iceberg prefix. The three fields wire up like this, for account
`<acct>` and bucket `<bucket>`:

```yaml
catalogs:
  omicidx:                                   # your public name; clients use this
    endpoint: https://catalog.cloudflarestorage.com/${CF_ACCOUNT_ID}/${R2_BUCKET}
    backend_warehouse: ${CF_ACCOUNT_ID}_${R2_BUCKET}
    backend_prefix: ${R2_CATALOG_PREFIX}     # R2's stable per-catalog UUID
    auth:
      bearer_token: ${CF_API_TOKEN_RO}       # default for every request
      bearer_token_write: ${CF_API_TOKEN_RW} # only for principals granted write
    capabilities:
      read: true
      write: false
```

### Setup steps

1. **Enable the R2 Data Catalog on the bucket** (Cloudflare dashboard, or
   wrangler's `r2 bucket catalog enable`).
2. **Mint the backend token pair** with `scripts/create-backend-tokens.sh`
   (needs `CF_ACCOUNT_ID`, `R2_BUCKET`, and a `CLOUDFLARE_API_TOKEN` holding
   *Account API Tokens Write*). It creates one read-only and one read-write
   token, both storage-scoped to the single bucket — the dashboard presets
   cannot express that; read the warning below before substituting your own.
3. **Discover the catalog's prefix.** R2 returns a stable per-catalog UUID as
   `overrides.prefix`; every path after `/v1/` must carry it or R2 404s. Fetch
   it once:

   ```bash
   curl -sf -H "Authorization: Bearer $CF_API_TOKEN_RO" \
     "https://catalog.cloudflarestorage.com/$CF_ACCOUNT_ID/$R2_BUCKET/v1/config?warehouse=${CF_ACCOUNT_ID}_${R2_BUCKET}" \
     | python3 -c 'import json,sys; print(json.load(sys.stdin)["overrides"]["prefix"])'
   ```

   Put that value in `backend_prefix`. (The gateway deliberately omits it when
   forwarding `/v1/config` itself, which is prefix-less by protocol.)
4. Deploy, then confirm `GET /v1/config?warehouse=omicidx` on the gateway
   returns `overrides.prefix = omicidx` and `overrides.uri` = your gateway URL.

### The anonymous-catalog token requirement

If your catalog is reachable **anonymously**, the token that serves anonymous
requests (`auth.bearer_token`) MUST be read-only on *both* the catalog and the
object store. This is not optional hardening — it is the only thing standing
between an anonymous reader and your bucket.

Why: clients reach data through **credential vending**. The backend hands the
client SigV4 credentials in the `loadTable` response, and those credentials
inherit the *storage* permissions of the token the gateway authenticated with.
A catalog-read-only + storage-read-write token therefore still lets any client
that can call `loadTable` write objects directly into the bucket, including
catalog metadata files. `capabilities.write: false` blocks commits at the REST
layer and does nothing about that path.

The two-token split makes this structural: reads — anonymous and read-only
keys alike — never touch the write token, so a read-path bug would have to
actively select the wrong token to leak write access. Keep writes behind API
keys (`permissions: [write]` principals get `bearer_token_write`), as
`config.production.yaml` does.

### Blast radius

R2's *catalog* permission groups are **account-scoped**; a token's catalog
half can read (or write) every R2 Data Catalog in the Cloudflare account. The
*storage* half, however, CAN be scoped to a single bucket — but only for
tokens created through the token API; the dashboard R2 presets ("Admin Read
only", "Admin Read & Write") are account-wide on both halves. That is why
`scripts/create-backend-tokens.sh` exists: it pairs the account-scoped catalog
group with a bucket-scoped `Workers R2 Storage Bucket Item Read`/`Write`
group, so vended credentials cannot reach any other bucket. For catalog
*metadata* isolation the boundary is still the Cloudflare **account**.

### Vended credentials and remote signing

The gateway forwards `X-Iceberg-Access-Delegation: vended-credentials` and the
resulting credentials unchanged; it never proxies object storage bytes.
PyIceberg and DuckDB send that header by default. Spark and Trino do not — that
is a client-side setting, covered in [users.md](users.md).

**Remote signing does not work through the gateway.** R2 advertises an absolute
`s3.signer.uri` on its own host, and signing there needs backend credentials
the client does not hold. Clients must use vended credentials and set
`s3.remote-signing-enabled=false`, which matches Cloudflare's own client
recipes.

---

## 7. Observability

### Request logs

One JSON object per request on stdout (`console.log`) — Workers tail logs, or
container stdout on Node. Fields:

| Field | Notes |
| --- | --- |
| `timestamp` | ISO-8601 |
| `requestId` | the client's `X-Request-Id` if present, otherwise generated |
| `clientIp` | `CF-Connecting-IP`, else `X-Forwarded-For`, else `null` |
| `principal` | principal name, `"anonymous"`, or `null` outside `/v1/*` |
| `namespace` | decoded namespace, or `null` |
| `backend` | the public catalog name the request resolved to, or `null` |
| `status` | HTTP status |
| `latencyMs` | gateway-observed duration, backend time included |

No Iceberg metadata and no tokens are ever logged.

### Metrics (Node only, `GET /metrics`, Prometheus text format)

| Metric | Type | Labels |
| --- | --- | --- |
| `requests_total` | counter | `method`, `status` |
| `request_duration_seconds` | histogram | none (buckets 0.005 … 10 s) |
| `backend_errors_total` | counter | `backend` — counts 5xx responses on requests that resolved to a catalog |
| `auth_failures_total` | counter | none — every 401 and 403 |
| `active_requests` | gauge | none |

Counters live in process memory: they reset on restart and are per-instance, so
scrape each replica separately and aggregate in Prometheus.

### Error responses

All gateway-generated errors use the Iceberg `ErrorModel` envelope
(`{"error": {"message", "type", "code"}}`):

| Status | Means |
| --- | --- |
| 400 | malformed percent-encoding in the request path |
| 401 | no credentials and anonymous disabled, or an unrecognized bearer token |
| 403 | operation not permitted by the principal's `permissions`/`namespaces`, or blocked by the catalog's `capabilities` |
| 404 | unknown `?warehouse=` value, or unknown catalog prefix in the path |
| 502 | backend catalog timed out (30 s, fixed), refused or dropped the connection |
| 500 | gateway fault — on Workers, most often an unset `${VAR}` or invalid bundled config |

Backend status codes are otherwise passed through untouched.

### Triage quick reference

* **`/health` fine, everything under `/v1/` is 500 (Workers)** — config failed
  to load. Almost always a secret that was never `wrangler secret put`.
* **404 on `/v1/config?warehouse=X`** — `X` is not a key under `catalogs`.
* **Clients bypass the gateway and hit the backend directly** — the
  `/v1/config` response transform did not run; check that clients are reaching
  the gateway origin and that `overrides.uri` in the response is your gateway.
* **404s from the backend on every non-config request (R2)** — `backend_prefix`
  is missing or stale; re-discover the UUID.
* **Backend returns 403 with no useful body** — a foreign `Host` header reaches
  the Cloudflare edge; the gateway sets `Host` from the target URL, so suspect
  an intermediary if you see this.
