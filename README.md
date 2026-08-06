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
catalogs:
  omicidx:
    endpoint: https://catalog.cloudflarestorage.com/${CF_ACCOUNT_ID}/${R2_BUCKET}
    backend_warehouse: ${CF_ACCOUNT_ID}_${R2_BUCKET}
    backend_prefix: ${R2_CATALOG_PREFIX}
    auth: { bearer_token: ${CF_API_TOKEN} }
    capabilities: { read: true, write: false }
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

## Status

v0.1.x — deployed and verified end-to-end (PyIceberg with vended credentials
against a live R2 Data Catalog; 32/32 spec acceptance checks with real
clients). R2 Data Catalog itself is in public beta. Design decisions and
research findings live on the
[issues](https://github.com/seandavi/icegate/issues?q=label%3Awayfinder%3Amap);
security reports: [SECURITY.md](SECURITY.md).

## License

[Apache-2.0](LICENSE) © icegate contributors. If icegate is useful in your
research, see [CITATION.cff](CITATION.cff).
