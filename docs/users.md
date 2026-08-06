# Connecting to an icegate endpoint

icegate is a gateway in front of an Apache Iceberg REST Catalog. To a client
it *is* an Iceberg REST Catalog: point any Iceberg client at the gateway URL
and use it normally. There is no icegate SDK and no gateway-specific client
setting.

Running a gateway is a different job — see [operators.md](operators.md) and
[../SPEC.md](../SPEC.md).

Every snippet below is marked **Verified** (taken from the acceptance suite in
`tests-acceptance/`, which runs these clients against a real catalog through
the gateway) or **Unverified** (correct per client documentation, not
exercised by our tests).

---

## What you need

| | |
|---|---|
| **Endpoint URL** | e.g. `https://icegate.example.com` — the base URI, with no `/v1` and no trailing path. |
| **Catalog name** | The `warehouse` value, e.g. `omicidx`. One gateway can front several catalogs; the name selects one. |
| **API key** | `icegate_` followed by 32 characters, e.g. `icegate_7f3Kd...`. Not needed for anonymous catalogs. |

Ask whoever runs the gateway for all three. Keys are issued once and stored
only as a hash, so a lost key is replaced, not recovered.

Substitute `https://icegate.example.com`, `omicidx`, and `icegate_...`
throughout.

---

## Authentication

The key goes in a standard bearer header:

```
Authorization: Bearer icegate_7f3Kd...
```

Every Iceberg client supports a static bearer token, so this is a
configuration value, never custom code. The gateway never forwards your key to
the backend catalog; it substitutes its own backend credentials.

A quick check that a key and endpoint work together:

```sh
curl -s -H "Authorization: Bearer icegate_7f3Kd..." \
  "https://icegate.example.com/v1/config?warehouse=omicidx"
```

A 200 with a JSON body containing `"prefix": "omicidx"` means you are through.

### What the error codes mean

| Code | Meaning |
|---|---|
| **401** | The key was not recognized — wrong or revoked key, or no key sent to a gateway that does not allow anonymous access. A malformed or unknown bearer token never falls back to anonymous. |
| **403** | The key is valid, but the principal is not allowed to do this: the namespace is not in your grant, the operation is a write and you have read only, or the catalog itself is read-only. |
| **404** | Unknown catalog name — the `warehouse` value or the prefix in the path does not exist on this gateway. |
| **502** | The backend catalog is unreachable or timed out. Not your key; retry or tell the operator. |

Namespace grants are top-level: access to `geo` also covers `geo.sub` and
anything below it.

---

## PyIceberg

**Verified** — `tests-acceptance/pyiceberg_check.py`, PyIceberg 0.11.1.

```python
from pyiceberg.catalog import load_catalog

catalog = load_catalog(
    "icegate",
    **{
        "type": "rest",
        "uri": "https://icegate.example.com",
        "warehouse": "omicidx",
        "token": "icegate_7f3Kd...",
    },
)

catalog.list_namespaces()
table = catalog.load_table("geo.samples")
table.scan().to_arrow()
```

The equivalent `~/.pyiceberg.yaml`, if you prefer configuration to code
(**unverified** — same four properties, not exercised by the suite):

```yaml
catalog:
  icegate:
    type: rest
    uri: https://icegate.example.com
    warehouse: omicidx
    token: icegate_7f3Kd...
```

Then `load_catalog("icegate")` with no arguments.

PyIceberg requests vended storage credentials by default (since 0.6.0), so
reading table data needs no object-storage configuration from you.

Caveat: released PyIceberg versions read credentials from the `config` field
of the `loadTable` response and ignore the newer `storage-credentials` field
([iceberg-python#3042](https://github.com/apache/iceberg-python/pull/3042),
unreleased as of this writing). If data reads fail with access errors while
metadata calls succeed, check that first.

---

## DuckDB

**Verified** — `tests-acceptance/run.sh`.

```sql
INSTALL iceberg;
LOAD iceberg;

CREATE SECRET ice (TYPE ICEBERG, TOKEN 'icegate_7f3Kd...');
ATTACH 'omicidx' AS ice (TYPE ICEBERG, ENDPOINT 'https://icegate.example.com');

SELECT * FROM ice.geo.samples LIMIT 10;
```

The string given to `ATTACH` is the catalog name; `ENDPOINT` is the gateway
URL. DuckDB fetches `/v1/config` once at `ATTACH` time and requests vended
credentials by default, feeding them into a DuckDB secret automatically.

`duckdb-iceberg` has no tagged releases — it ships with DuckDB from pinned
commits, so "version" means build date. Builds from before 2026-07-26 ignore
the `uri` the gateway advertises
([duckdb-iceberg#1230](https://github.com/duckdb/duckdb-iceberg/pull/1230)),
which is harmless here because they stay on the `ENDPOINT` you gave them —
the gateway either way. Use a recent build regardless.

---

## Spark

**Unverified** — the Iceberg Java REST client's conformance was confirmed by
source review (issue #3), but our acceptance suite does not run Spark.

| Property | Value |
|---|---|
| `spark.sql.catalog.icegate` | `org.apache.iceberg.spark.SparkCatalog` |
| `spark.sql.catalog.icegate.type` | `rest` |
| `spark.sql.catalog.icegate.uri` | `https://icegate.example.com` |
| `spark.sql.catalog.icegate.warehouse` | `omicidx` |
| `spark.sql.catalog.icegate.token` | `icegate_7f3Kd...` |
| `spark.sql.catalog.icegate.header.X-Iceberg-Access-Delegation` | `vended-credentials` |

The `header.X-Iceberg-Access-Delegation` property is required: unlike
PyIceberg and DuckDB, Spark does not ask for vended credentials on its own,
and without it you must supply object-storage credentials yourself. Iceberg
0.14.0 or newer for the prefix/uri handling; for `storage-credentials`
support, a release built after
[iceberg#12591](https://github.com/apache/iceberg/pull/12591) (merged April
2025).

---

## Trino

**Unverified** — same caveat as Spark, plus an upstream bug (below).

| Property | Value |
|---|---|
| `connector.name` | `iceberg` |
| `iceberg.catalog.type` | `rest` |
| `iceberg.rest-catalog.uri` | `https://icegate.example.com` |
| `iceberg.rest-catalog.warehouse` | `omicidx` |
| `iceberg.rest-catalog.oauth2.token` | `icegate_7f3Kd...` |
| `iceberg.rest-catalog.vended-credentials-enabled` | `true` |

Trino has no `bearer-token` property — a static key goes in
`oauth2.token`, which Trino sends as `Authorization: Bearer <value>`.
Vended credentials are off by default and some Trino code paths ignore them
even when enabled ([trinodb/trino#27416](https://github.com/trinodb/trino/issues/27416));
if data reads fail, fall back to static object-storage credentials as
described under Known issues. Trino 405 or newer for the REST catalog.

Remote request signing is not supported through the gateway. Where a client
exposes the setting, leave it off (`s3.remote-signing-enabled=false`) and use
vended or static credentials.

---

## Anonymous (public) catalogs

If the operator has enabled anonymous access, the same configurations work
with the token omitted. **Unverified as client configuration** — the anonymous
path itself is covered by the acceptance suite over HTTP, but not through
these clients.

PyIceberg:

```python
catalog = load_catalog(
    "icegate",
    **{"type": "rest", "uri": "https://icegate.example.com", "warehouse": "omicidx"},
)
```

DuckDB — drop the `CREATE SECRET`, keep the `ATTACH`:

```sql
ATTACH 'omicidx' AS ice (TYPE ICEBERG, ENDPOINT 'https://icegate.example.com');
```

Anonymous principals are typically scoped to a few namespaces and to reads;
anything outside that grant is a 403, not a 401. Sending an invalid key is
worse than sending none — an unrecognized bearer token is a 401 and never
falls back to anonymous.

Anonymous *catalog* access still relies on vended credentials for the data
files themselves. A client that does not request them (Spark, Trino) needs
object-storage credentials from somewhere, which an anonymous catalog does
not give you.

---

## Known issues

### StarRocks with vended credentials against R2

Tracked as [icegate#23](https://github.com/seandavi/icegate/issues/23) and
reported upstream as
[StarRocks#77365](https://github.com/StarRocks/starrocks/issues/77365).

With `vended-credentials-enabled = 'true'`, StarRocks lists databases and
tables and answers `count(*)` correctly — all of that is manifest metadata,
read by the FE, which does honor the configured S3 endpoint. Reading actual
data files fails on the CN:

```
BE access S3 file failed, SdkResponseCode=404, SdkErrorType=132,
SdkErrorMessage=The specified bucket does not exist
```

The vended credentials themselves are fine (the same credentials read the same
object successfully via boto3). The S3 endpoint configuration does not reach
the CN when vending is on, so it resolves the bucket against the default AWS
endpoint. This affects any S3-compatible object store behind vended
credentials, not just R2, and is invisible on real AWS where the default
endpoint happens to be right. The gateway is not involved: it forwards the
catalog's credentials and endpoint configuration unchanged.

Workaround — turn vending off and supply static keys:

```
iceberg.catalog.vended-credentials-enabled = 'false'
aws.s3.access_key = '...'
aws.s3.secret_key = '...'
```

Measured after the switch: a 56.4M-row grouped scan in 10.9s, a 454M-row
grouped scan in 25.3s.

Static keys give the engine broad bucket access and lose the per-table scoping
that vending exists to provide. Ask the operator for a scoped, read-only token
for this engine rather than reusing a general-purpose one.

### Clients that do not request vended credentials

Spark and Trino do not send `X-Iceberg-Access-Delegation` unless configured to
(see their sections above). The gateway forwards the header when a client
sends it and forwards the resulting credentials unchanged, but it cannot make
a client ask.
