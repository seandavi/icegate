"""SPEC §19 transparency: PyIceberg reaches the catalog through icegate with an
unmodified load_catalog() call — no custom URL, no gateway-specific property.

Run by tests-acceptance/run.sh; prints one "  PASS <name>" line per check and
exits non-zero on the first failure.
"""

import sys

import pyiceberg
from pyiceberg.catalog import load_catalog
from pyiceberg.schema import Schema
from pyiceberg.types import LongType, NestedField, StringType

GATEWAY, API_KEY = sys.argv[1], sys.argv[2]

SCHEMA = Schema(
    NestedField(1, "id", LongType(), required=False),
    NestedField(2, "name", StringType(), required=False),
)


def check(name: str, actual, expected) -> None:
    if actual != expected:
        raise SystemExit(f"  FAIL  {name}: expected {expected!r}, got {actual!r}")
    print(f"  \033[32mPASS\033[0m  {name}")


print(f"pyiceberg: {pyiceberg.__version__}")

# The one and only gateway-aware thing here is the URI the operator hands out.
catalog = load_catalog(
    "icegate",
    **{"type": "rest", "uri": GATEWAY, "warehouse": "omicidx", "token": API_KEY},
)

check("PyIceberg load_catalog() works unchanged", type(catalog).__name__, "RestCatalog")
# Both come from the gateway's /v1/config rewrite (SPEC §11): a backend-supplied
# uri here would mean the client had been routed around the gateway.
check("client stays on the gateway URI", catalog.uri.rstrip("/"), GATEWAY.rstrip("/"))
check("client adopted overrides.prefix", catalog.properties.get("prefix"), "omicidx")

catalog.create_namespace_if_not_exists("geo")
catalog.create_namespace_if_not_exists("private")
namespaces = catalog.list_namespaces()
check("create + list namespaces", sorted(namespaces), [("geo",), ("private",)])

if ("geo", "samples") in catalog.list_tables("geo"):
    catalog.drop_table("geo.samples")
catalog.create_table("geo.samples", schema=SCHEMA)
check("list tables", catalog.list_tables("geo"), [("geo", "samples")])

table = catalog.load_table("geo.samples")
check("load table", table.name(), ("geo", "samples"))
check("table schema round-tripped", [f.name for f in table.schema().fields], ["id", "name"])
