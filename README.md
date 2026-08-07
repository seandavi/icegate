# icegate

[![CI](https://github.com/seandavi/icegate/actions/workflows/ci.yml/badge.svg)](https://github.com/seandavi/icegate/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/seandavi/icegate)](https://github.com/seandavi/icegate/releases)
[![Iceberg REST](https://img.shields.io/badge/Iceberg-REST%20Catalog%20v1-2b6cb0)](https://iceberg.apache.org/rest-catalog-spec/)
[![Runs on](https://img.shields.io/badge/runs%20on-Cloudflare%20Workers%20%7C%20Node%20%7C%20Docker-f38020)](docs/operators.md)
[![Gateway overhead](https://img.shields.io/badge/median%20overhead-0.40%20ms-brightgreen)](https://github.com/seandavi/icegate/issues/12)
[![State](https://img.shields.io/badge/state-none%2C%20it's%20a%20proxy-9cf)](SPEC.md)

**A stateless edge gateway for Apache Iceberg REST Catalogs.**

icegate is a stateless reverse proxy that sits in front of an existing
Iceberg REST catalog, adding API-key authentication, multi-tenant catalog
routing, and per-key read/write authorization — without replacing the catalog
or storing any metadata. The gateway shape matters when the catalog is managed
and cannot be extended: [Cloudflare R2 Data Catalog](https://developers.cloudflare.com/r2/data-catalog/)
authenticates only with account-scoped API tokens that are read-only or
read-write for the *entire* catalog, offering no per-user, per-namespace, or
per-table policy. icegate holds that token server-side and issues scoped keys
in its place. R2 is currently the only provider combining a managed Iceberg
REST catalog, S3-compatible storage, zero egress fees, and credential vending
([survey](https://github.com/seandavi/icegate/issues/26)) — which is what
makes a catalog worth sharing, and therefore worth fronting.

To a client, icegate *is* an Iceberg REST catalog. Table data never flows
through it: clients read object storage directly with credentials vended by
the backend.

## Features

- **API keys** — `icegate_...` bearer tokens, stored only as SHA-256 digests;
  the backend credential never reaches clients.
- **Per-key authorization** — namespace grants and read/write permissions per
  principal; per-catalog read/write capability kill switches.
- **Multi-catalog routing** — one gateway fronts many backends (R2, Polaris,
  Lakekeeper, Glue, anything Iceberg-REST) under one hostname; the catalog
  name in the URL selects the backend.
- **Anonymous catalogs** — optional keyless read access, scoped by namespace.
- **Bypass-proof** — the `/v1/config` response is rewritten so clients keep
  talking to the gateway, never the backend directly.
- **Vended credentials pass through** — clients read object storage directly;
  the gateway adds 0.40 ms median overhead to metadata calls only.
- **Stateless** — no database, no cache; one YAML file is the entire state.
- **CORS for browser clients** (DuckDB-WASM) — R2's catalog serves no CORS
  headers of its own.
- **Observability** — structured JSON request logs everywhere; Prometheus
  `/metrics` on the Node target.

## Client support

| Client | Status |
| --- | --- |
| PyIceberg | ✅ Verified by the [acceptance suite](tests-acceptance/) |
| DuckDB | ✅ Verified by the acceptance suite |
| Spark | 🟡 Config documented, not yet exercised by our tests |
| Trino | 🟡 Config documented, not yet exercised by our tests |
| StarRocks | ⚠️ Works with static keys; vended credentials broken upstream ([#23](https://github.com/seandavi/icegate/issues/23)) |

Anything speaking the Iceberg REST catalog protocol with a static bearer
token should work — details and per-client snippets in the
[user guide](docs/users.md).

## Quickstart (as a client)

Someone gives you an endpoint, a catalog name, and a key. Then, in DuckDB:

```sql
INSTALL iceberg; LOAD iceberg;
CREATE SECRET ice (TYPE ICEBERG, TOKEN 'icegate_...');
ATTACH 'omicidx' AS ice (TYPE ICEBERG, ENDPOINT 'https://icegate.example.com');
SELECT * FROM ice.geo.samples LIMIT 10;
```

or PyIceberg:

```python
from pyiceberg.catalog import load_catalog

catalog = load_catalog("icegate", **{
    "type": "rest",
    "uri": "https://icegate.example.com",
    "warehouse": "omicidx",
    "token": "icegate_...",
})
catalog.load_table("geo.samples").scan().to_arrow()
```

Both snippets are exercised against a real catalog by the
[acceptance suite](tests-acceptance/). Spark, Trino, anonymous access, and
troubleshooting: **[user guide](docs/users.md)**.

## Run your own

One YAML file is the entire state. Point it at your backend, add key digests,
deploy to Cloudflare Workers (primary), Node, or Docker:

```yaml
authentication:
  anonymous: { enabled: true, namespaces: [geo], permissions: [read] }
  api_keys:
    enabled: true
    alice:
      sha256: 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08
      namespaces: [geo, tcga]
      permissions: [read, write]

catalogs:
  omicidx:            # public read-mostly catalog on R2
    endpoint: https://catalog.cloudflarestorage.com/${CF_ACCOUNT_ID}/${R2_BUCKET}
    backend_warehouse: ${CF_ACCOUNT_ID}_${R2_BUCKET}
    backend_prefix: ${R2_CATALOG_PREFIX}
    # read-only token for everyone; write keys get the (optional) write token
    auth: { bearer_token: ${CF_API_TOKEN_RO}, bearer_token_write: ${CF_API_TOKEN_RW} }
    capabilities: { read: true, write: false }
  scratch:            # second backend behind the same gateway
    endpoint: https://polaris.internal.example.com
    backend_warehouse: scratch
    auth: { bearer_token: ${POLARIS_TOKEN} }
    capabilities: { read: true, write: true }
```

Full configuration reference, key minting, the three deploy paths, and the
R2-specific wiring (including the security-critical read-only-token rule for
anonymous catalogs): **[operator guide](docs/operators.md)**.

## Documentation

| Audience | Doc |
| --- | --- |
| I was handed a URL and a key | [User guide](docs/users.md) |
| I want to run a gateway | [Operator guide](docs/operators.md) |
| I want to change the code | [Developer guide](docs/developers.md) · [CONTRIBUTING](CONTRIBUTING.md) |
| I want the normative behavior | [SPEC.md](SPEC.md) — the design source of truth |

## Roadmap

Everything in [Features](#features) shipped in v0.1.0. Future work is driven
by [issues](https://github.com/seandavi/icegate/issues) — file one. Two open
threads today: Spark/Trino acceptance coverage, and the StarRocks upstream
fix (#23).

**Deliberately not planned** (SPEC §21) — icegate stays a stateless proxy:
OAuth/OIDC providers, rate limiting, dynamic config reload, multi-region
failover, health-aware backend routing, catalog discovery, admin or
key-management UIs, and policy engines. If you need fine-grained governance
(column masking, row filtering, audit lineage), run a real catalog like
[Polaris](https://polaris.apache.org/) or [Lakekeeper](https://docs.lakekeeper.io/)
instead — icegate's niche is adding auth to a catalog you *can't* extend.

## Status

v0.1.x — deployed and verified end-to-end (PyIceberg with vended credentials
against a live R2 Data Catalog; 32/32 spec acceptance checks with real
clients). R2 Data Catalog itself is in public beta. Design decisions and
research findings live on the
[issues](https://github.com/seandavi/icegate/issues?q=label%3Awayfinder%3Amap);
security reports: [SECURITY.md](SECURITY.md).

## How this was built

icegate was built as a human–AI collaboration: [Sean Davis](https://seandavi.github.io/)
set the destination and made the judgment calls; [Claude Code](https://claude.com/claude-code)
did the research, implementation, testing, and documentation.

The workflow is structured by [Matt Pocock](https://www.aihero.dev/)'s
engineering skills for Claude Code, which turn a vague goal into an
issue-tracked expedition: a **wayfinder** map charts the destination as a
GitHub issue with tickets as sub-issues; **grilling** tickets force decisions
(stack, key format, license) through the human before code gets written;
**research** tickets run autonomously and land their findings as citations on
the issue. The convention that makes it work is *the issues are the docs* —
every decision, dead end, and verification result is public in the tracker,
not buried in a chat log. The whole history is readable:
[map #1](https://github.com/seandavi/icegate/issues/1) built the gateway
(spec → research → implementation → acceptance tests → live deployment);
[map #24](https://github.com/seandavi/icegate/issues/24) made it an open
source project. [SPEC.md](SPEC.md) stayed the single source of truth
throughout — when reality disagreed with it, the spec was corrected in the
same commit, and the acceptance suite (real PyIceberg and DuckDB against a
real catalog) kept the claims honest.

## License

[Apache-2.0](LICENSE) © icegate contributors. If icegate is useful in your
research, see [CITATION.cff](CITATION.cff).
