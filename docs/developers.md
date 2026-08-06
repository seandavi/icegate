# Developer guide

How to get icegate running locally, what the request path looks like, and what
has to be green before you push. Design rationale lives in [SPEC.md](../SPEC.md);
working conventions in [AGENTS.md](../AGENTS.md) and
[CONTRIBUTING.md](../CONTRIBUTING.md). For running a deployment see
[operators.md](operators.md); for using a gateway see [users.md](users.md).

## 1. Setup

Prerequisites:

- Node.js 22 (the Docker image pins `node:22-slim`). npm ships with it.
- Nothing else for the unit suite — `wrangler` and the Workers test pool are
  devDependencies. The acceptance suite needs more (§3).

```sh
npm ci
```

Two ways to run it, one codebase:

```sh
npm run dev         # wrangler dev — the Workers target, http://localhost:8787
npm run start:node  # tsx src/node.ts — the Node target, PORT defaults to 8787
```

Both read [`config.yaml`](../config.yaml) at the repo root. It is deliberately
free of `${VAR}` references so either command works with an empty environment;
it points at `catalog.example.invalid`, so requests reach routing and then fail
at the backend. Point at a real catalog by editing `config.yaml`, or on Node
by setting `ICEGATE_CONFIG=/path/to/config.yaml`. The interpolated form —
secrets as `${VAR}` — is [`examples/icegate.yaml`](../examples/icegate.yaml).

How the same file reaches both runtimes: `wrangler.jsonc` has a `Text` rule
that bundles `**/*.yaml` as a string module (typed by `src/yaml.d.ts`), so
Workers gets `config.yaml` inlined at build time; `src/node.ts` reads it with
`node:fs`. Core code never touches either mechanism.

Health check either target with `curl localhost:8787/health`.

## 2. Architecture

### Request lifecycle

```text
                      Request
                         │
      ┌──────────────────┴───────────────────┐
      │  metricsMiddleware   (all routes)    │  src/metrics/index.ts
      │  requestLogger       (all routes)    │  src/logging/index.ts
      └──────────────────┬───────────────────┘
                         │
        /health, /ready ─┤─ /v1/*
              (200)      │
                         │  ┌───────────────────────────────────┐
                         ├──│ config: loadConfig() once, then   │ src/index.ts
                         │  │ memoized on the isolate           │ src/config/
                         │  ├───────────────────────────────────┤
                         ├──│ CORS (if cors.enabled)            │ hono/cors
                         │  ├───────────────────────────────────┤
                         ├──│ parseGatewayPath(raw pathname)    │ src/context.ts
                         │  │   → { prefix, rest, namespace }   │
                         │  │   null → 400 ErrorModel           │
                         │  ├───────────────────────────────────┤
                         ├──│ authMiddleware: authn then authz  │ src/auth/
                         │  │   401 / 403 exit here             │
                         │  └───────────────────────────────────┘
                         │
      ┌──────────────────┴───────────────────┐
      │  catalogRoutes                       │  src/routing/routes.ts
      │   GET /v1/config?warehouse=…         │
      │   ALL /v1/:prefix/*                  │
      │  resolveCatalog() → 404 if unknown   │  src/routing/index.ts
      └──────────────────┬───────────────────┘
                         │
                    forward()                   src/proxy/index.ts
                         │   client bearer dropped, catalog token set,
                         │   hop-by-hop headers stripped, 30s timeout
                         ▼
                    Backend catalog
                         │
                         │   /v1/config only: transformConfigResponse()
                         ▼
                      Response
```

Things worth knowing about that order:

- **CORS runs before auth.** A browser preflight (DuckDB-WASM) carries no
  `Authorization` header, so if auth ran first every preflight would 401 and no
  browser client could reach the gateway. CORS is scoped to `/v1/*`; `/health`
  and `/ready` are not browser surface and stay config-free (SPEC §11, §16).
- **Config loads on the first `/v1/*` request, not at module scope.** On
  Workers the env bindings that `${VAR}` resolves against only exist per
  request. After the first load it is memoized for the isolate's lifetime;
  there is no reload — restart to pick up a config change.
- **Auth and routing are mounted on the same Hono app**, not dispatched into a
  sub-app. A nested `fetch()` would build a second context, and the principal,
  namespace and backend set downstream would never reach the logger or metrics
  middleware sitting above (SPEC §13, §14).
- **The path is parsed exactly once**, at entry, from `new URL(c.req.url).pathname`
  — never `c.req.path`, which Hono has already percent-decoded. `namespace` is
  decoded once; `rest` is not decoded at all, because Iceberg's `%1F` multipart
  separators must reach the backend still encoded. Malformed encoding returns
  400 rather than surfacing a `URIError` as a 500.

### Module map (`src/`)

| File | Responsibility |
| --- | --- |
| `index.ts` | The Hono app: middleware order, the `/v1/*` chain, `useConfig()` injection seam, default export consumed by both entrypoints. |
| `node.ts` | Node entrypoint: reads `config.yaml` with `node:fs`, injects it, registers `/metrics`, serves with `@hono/node-server`. The only file allowed to touch `process.env` or `node:*`. |
| `context.ts` | `parseGatewayPath()` plus the `ContextVariableMap` declaration that makes `c.get`/`c.set` typed (`requestId`, `config`, `path`, `principal`, `namespace`, `backend`). |
| `errors.ts` | `errorResponse(code, type, message)` — the single Iceberg `ErrorModel` envelope (SPEC §15). |
| `config/index.ts` | Zod schema (`.strict()` throughout), `${VAR}` interpolation against a caller-supplied env map, `loadConfig()`. Exports the `Config` type. |
| `auth/index.ts` | `sha256Hex()` via Web Crypto, digest→principal index, read/write classification, namespace scoping, catalog `capabilities` check. |
| `routing/index.ts` | `resolveCatalog()`, `backendBase()`, `buildBackendUrl()`, `backendConfigUrl()`, `transformConfigResponse()`. |
| `routing/routes.ts` | The two Iceberg REST routes and the shared `proxy()` helper that records the backend and calls `forward()`. |
| `proxy/index.ts` | `forward()` — the one place an outbound `fetch()` happens; also `Location` rewriting and the Content-Encoding fixups. |
| `logging/index.ts` | One structured JSON line per request to `console.log` (SPEC §13). |
| `metrics/index.ts` | In-memory Prometheus counters plus `renderMetrics()`. Middleware runs everywhere; the endpoint is Node-only (SPEC §14). |
| `yaml.d.ts` | Declares `*.yaml` as a text module for the wrangler bundle. |

`src/transform/` exists as an empty directory; the transform functions live in
`routing/index.ts`.

### The seams

Four places absorb change; prefer extending them over adding a parallel path.

**`useConfig(config)`** (`src/index.ts`) — config enters the app by injection.
`node.ts` uses it to keep `node:fs` out of core; every test uses it to install a
config literal without touching disk. Note the interaction with memoization:
`tests/bundled-config.test.ts` lives in its own file precisely because any
`useConfig()` call would pre-empt the bundled `config.yaml` it asserts on.

**`parseGatewayPath()`** (`src/context.ts`) — one parse, three consumers
(auth, both routes). Encoding bugs are fixed here, once.

**`forward()`** (`src/proxy/index.ts`) — the single egress point. Credential
swap, hop-by-hop header stripping, timeout→502, redirect rewriting and the
Content-Encoding fixup all live here, so both routes get them. The two routes
used to forward separately and drifted: one dropped query parameters, one
re-encoded the body.

**`errorResponse()`** (`src/errors.ts`) — every gateway-originated error goes
through it, so clients see one envelope shape.

### Transforms

Only two rewrites exist; everything else is passed through (SPEC §11).

`GET /v1/config` is the odd one. The client's `warehouse` parameter is replaced
with the catalog's `backend_warehouse`; every other query parameter rides along.
`backend_prefix` is **never** inserted into this request — `/v1/config` is
prefix-less by protocol (the prefix is what the response hands out), and R2 404s
if you insert one. The response then gets `overrides.prefix` set to the public
catalog name, `overrides.uri` set to the gateway origin, and any `defaults.uri`
deleted — PyIceberg merges both maps and re-reads `uri`, so a surviving backend
`uri` sends the client straight to the backend. `endpoints` and everything else
are forwarded untouched.

Every other request is `/v1/<prefix>/<rest>` → `<endpoint>/v1/[<backend_prefix>/]<rest>`.
`endpoint` may carry its own path segments (R2 Data Catalog serves at
`.../<account_id>/<bucket>`), and those precede `/v1`. `backend_prefix` must be
a single path segment; an empty string means none.

### Error model

`{ "error": { "message", "type", "code" } }`, always. 400 malformed
percent-encoding · 401 no or unmatched credential · 403 permission, namespace
scope or catalog capability · 404 unknown warehouse or prefix · 502 backend
unreachable or timed out. 503 stays reserved for the gateway's own
unavailability. Backend responses pass through with their own status.

## 3. Testing

Three commands. The first two must both be green before you push.

```sh
npm test                 # vitest run — the unit suite
npx tsc --noEmit         # also: npm run typecheck
npm run test:acceptance  # the containerized suite, see below
```

### Unit suite

Vitest running on `@cloudflare/vitest-pool-workers`, so tests execute in a real
`workerd` isolate against `wrangler.jsonc` — not in Node with a shim. Tests
drive the composed app through `app.request(...)`, install config with
`useConfig(loadConfig(yaml, {}))`, and stub the backend with
`vi.stubGlobal("fetch", vi.fn())`. Copy the setup block at the top of
`tests/transport.test.ts` or `tests/config-handler.test.ts` for a new test.

| File | Covers |
| --- | --- |
| `config.test.ts` | Schema validation, unknown-key rejection, `${VAR}` interpolation failures. |
| `bundled-config.test.ts` | The real `config.yaml` loads and routes on the first request. |
| `auth.test.ts` | The authn/authz matrix through the composed app. |
| `routing.test.ts` | `resolveCatalog`, `buildBackendUrl`, `transformConfigResponse` as units. |
| `config-handler.test.ts` | Both routes end to end against a stubbed backend. |
| `transport.test.ts` | `forward()` behavior: 502s, `/v1/config` transparency, content encoding, CORS. |
| `app.test.ts` | Pipeline order, and that the context reaches logging and metrics. |
| `logging.test.ts`, `metrics.test.ts`, `health.test.ts` | The observability and health surfaces. |

### Acceptance suite

`npm run test:acceptance` runs [`tests-acceptance/run.sh`](../tests-acceptance/run.sh),
the SPEC §19 checks against real software rather than mocks. It is
non-interactive and idempotent: every run gets a fresh container, a fresh
warehouse and fresh gateway processes, and tears them all down on exit.

Required on PATH — the script preflights and exits if any is missing:
`docker` (or `podman`), `uv`, `duckdb`, `node`, `curl`, `jq`.

What it spins up: an `apache/iceberg-rest-fixture` container on port 18181 with
a file warehouse in a temp dir, and **two** Node gateway instances (ports 18787
and 18788) on a generated config with two catalogs — one plain, one with
`backend_prefix: bknd` to prove prefix substitution. Then it checks:
invalid config fails startup; PyIceberg 0.11.1 (`pyiceberg_check.py`, run via
`uv`) and DuckDB with the iceberg extension both work through the gateway with
nothing but a normal `load_catalog`/`ATTACH`; the routing and auth matrices;
statelessness (the two instances return identical bytes, and `/v1/config` is
compared with `overrides.uri` dropped since each must advertise its own origin);
that nothing was written into the project tree; a 100-request concurrency check
(`perf.mjs`); and finally, because it kills the fixture, backend-down → 502.

Overridable via environment: `CONTAINER`, `ICEBERG_REST_IMAGE`, `BACKEND_PORT`,
`GW1_PORT`, `GW2_PORT`.

Deliberately not covered: R2 vended credentials (needs a live Cloudflare token)
and the Spark/Trino clients (same Iceberg Java client, conformance verified on
issue #3).

## 4. Conventions

Read [AGENTS.md](../AGENTS.md) — it applies to humans too — and
[CONTRIBUTING.md](../CONTRIBUTING.md). The parts that bite most often:

- **SPEC first.** [SPEC.md](../SPEC.md) is the design source of truth, and
  several sections encode research findings (client config-merge behavior, R2
  addressing, the `defaults.uri` bypass) — treat MUSTs literally. If your change
  contradicts the SPEC, update SPEC.md in the same commit and say so.
- **The issues are the docs.** Rationale and findings land as a resolution
  comment on the ticket, not in a `docs/adr/` file.
- **Workers first.** No runtime-specific APIs in core: Web Crypto, not
  `node:crypto`; `process.env` only in `src/node.ts`; the `/metrics` endpoint
  only in the Node entry.
- **No new dependencies** without an issue recording the decision.
- **TypeScript strict**, Zod `.strict()` everywhere, non-trivial logic lands
  with a test, smallest working diff.
- Use a git worktree if you are working alongside someone else; commit messages
  end with `(#<ticket>)`.

## 5. Known deepening candidates

From the architecture pass on
[issue #15](https://github.com/seandavi/icegate/issues/15). Two candidates were
adopted (the typed request context, and the single `GatewayPath` model). These
were surfaced, deliberately not applied, and recorded so a later pass does not
re-derive them — adopt one when its friction actually bites:

1. **Collapse the routing helpers and proxy into one deep gateway module**
   behind `catalogRoutes(config)`. The two `/v1` handlers still diverge on query
   parameters, headers and error envelope, and `backendBase` is exported only so
   proxy can reverse it.
2. **Let config own its types and encodings.** `auth` re-implements the reserved
   `enabled` catchall with a cast, and tests build `Config` literals that bypass
   `loadConfig`.
3. **One observability module with `reset()`.** Two independent timers,
   divergent throw semantics, counters that cannot be reset between tests.

Also noted and not ticketed: `/metrics` self-instruments its own scrape on Node.
