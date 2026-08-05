#!/usr/bin/env bash
# SPEC §19 acceptance checks: a real Iceberg REST catalog in a container, real
# clients (PyIceberg, DuckDB), icegate's Node entry proxying in between.
#
#   npm run test:acceptance
#
# Needs docker (or podman), uv, the duckdb CLI and node. Non-interactive and
# idempotent: every run gets a fresh container, a fresh warehouse and fresh
# gateway processes, and tears them all down on exit.
#
# Not covered here, deliberately: R2 vended credentials (needs a live
# Cloudflare token) and the Spark/Trino clients (same Iceberg Java client,
# conformance verified on issue #3). See the §19 table in the ticket.
set -uo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
CONTAINER=${CONTAINER:-$(command -v docker >/dev/null 2>&1 && echo docker || echo podman)}
IMAGE=${ICEBERG_REST_IMAGE:-apache/iceberg-rest-fixture:latest}
NAME=icegate-acceptance
BACKEND_PORT=${BACKEND_PORT:-18181}
GW1_PORT=${GW1_PORT:-18787}
GW2_PORT=${GW2_PORT:-18788}
BACKEND=http://127.0.0.1:$BACKEND_PORT
GW1=http://127.0.0.1:$GW1_PORT
GW2=http://127.0.0.1:$GW2_PORT

WORK=$(mktemp -d)
WAREHOUSE=$WORK/warehouse
# The container writes metadata as its own uid (the image's Hadoop FileIO fails
# under --user), and DuckDB reads those files back from the host — so the
# warehouse is mounted at an identical path on both sides and made writable.
mkdir -p "$WAREHOUSE" && chmod 777 "$WAREHOUSE"

API_KEY=acceptance-test-key
API_KEY_SHA=$(printf %s "$API_KEY" | sha256sum | cut -d' ' -f1)

PASSED=0
FAILED=0

pass() { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASSED=$((PASSED + 1)); }
fail() { printf '  \033[31mFAIL\033[0m  %s\n        %s\n' "$1" "$2"; FAILED=$((FAILED + 1)); }
section() { printf '\n\033[1m§19 %s\033[0m\n' "$1"; }

assert() { # name expected actual
  if [ "$2" = "$3" ]; then pass "$1"; else fail "$1" "expected [$2] got [$3]"; fi
}

assert_contains() { # name needle haystack
  case "$3" in *"$2"*) pass "$1" ;; *) fail "$1" "expected to contain [$2], got [$3]" ;; esac
}

status() { curl -s -o "$WORK/body.json" -w '%{http_code}' "$@"; }

cleanup() {
  for pid in ${GW1_PID:-} ${GW2_PID:-}; do kill "$pid" 2>/dev/null; done
  # The warehouse tree belongs to the container's uid, so let the container do
  # the deleting — started first, because the backend-failure check stops it.
  $CONTAINER start "$NAME" >/dev/null 2>&1 && $CONTAINER exec "$NAME" rm -rf "$WAREHOUSE" >/dev/null 2>&1
  $CONTAINER rm -f "$NAME" >/dev/null 2>&1
  rm -rf "$WORK" 2>/dev/null
}
trap cleanup EXIT

wait_for() { # url description
  for _ in $(seq 1 60); do
    curl -sf -o /dev/null "$1" && return 0
    sleep 1
  done
  echo "timed out waiting for $2 at $1" >&2
  return 1
}

# --- preflight -------------------------------------------------------------
for tool in $CONTAINER uv duckdb node curl jq; do
  command -v "$tool" >/dev/null 2>&1 || { echo "missing required tool: $tool" >&2; exit 1; }
done

echo "runtime:   $($CONTAINER --version)"
echo "node:      $(node --version)"
echo "duckdb:    $(duckdb -init /dev/null -noheader -list -c 'select version()' 2>/dev/null | tail -1)"
# duckdb-iceberg has no tagged releases — the build commit IS the version, and
# it is what decides conformance: `overrides.uri` is only honored from
# PR #1230 (2026-07-26) onward (issue #3). Older builds stay on the ENDPOINT
# given to ATTACH, which is the gateway either way, so the checks below hold.
echo "duckdb-iceberg: $(duckdb -init /dev/null -noheader -list \
  -c "INSTALL iceberg; LOAD iceberg; SELECT extension_version FROM duckdb_extensions() WHERE extension_name='iceberg'" \
  2>/dev/null | tail -1)"
echo "image:     $IMAGE"

# --- backend ---------------------------------------------------------------
$CONTAINER rm -f "$NAME" >/dev/null 2>&1
$CONTAINER run -d --name "$NAME" -p "$BACKEND_PORT:8181" \
  -v "$WAREHOUSE:$WAREHOUSE:z" \
  -e CATALOG_WAREHOUSE="file://$WAREHOUSE" \
  "$IMAGE" >/dev/null || { echo "failed to start $IMAGE" >&2; exit 1; }
wait_for "$BACKEND/v1/config" "iceberg rest fixture" || exit 1

# --- gateway config --------------------------------------------------------
# Exercises the §19 auth matrix: anonymous is read-only and scoped to `geo`,
# the API key principal additionally reaches `private` and may write. The
# second catalog exists only to prove backend-prefix substitution: the fixture
# has no route under `bknd`, and its 400 echoes the path it actually received.
cat > "$WORK/config.yaml" <<YAML
authentication:
  anonymous:
    enabled: true
    namespaces: [geo]
    permissions: [read]
  api_keys:
    enabled: true
    tester:
      sha256: $API_KEY_SHA
      namespaces: [geo, private]
      permissions: [read, write]

catalogs:
  omicidx:
    endpoint: $BACKEND
    backend_warehouse: file://$WAREHOUSE
    backend_prefix: ""
    auth:
      bearer_token: fixture-ignores-this
    capabilities:
      read: true
      write: true
  prefixed:
    endpoint: $BACKEND
    backend_warehouse: file://$WAREHOUSE
    backend_prefix: bknd
    auth:
      bearer_token: fixture-ignores-this
    capabilities:
      read: true
      write: true
YAML

# --- gateways --------------------------------------------------------------
# Two instances of the same Node entry on different ports (§19 statelessness).
ICEGATE_CONFIG="$WORK/config.yaml" PORT=$GW1_PORT npx tsx "$ROOT/src/node.ts" > "$WORK/gw1.log" 2>&1 &
GW1_PID=$!
ICEGATE_CONFIG="$WORK/config.yaml" PORT=$GW2_PORT npx tsx "$ROOT/src/node.ts" > "$WORK/gw2.log" 2>&1 &
GW2_PID=$!
wait_for "$GW1/health" "gateway 1" || { cat "$WORK/gw1.log"; exit 1; }
wait_for "$GW2/health" "gateway 2" || { cat "$WORK/gw2.log"; exit 1; }

# Snapshot the working tree now: nothing the gateways do may change it (§19).
tree_snapshot() {
  find "$ROOT" \( -name node_modules -o -name .git \) -prune -o -printf '%p %s %T@\n' | sort
}
tree_snapshot > "$WORK/tree.before"

# --- configuration ---------------------------------------------------------
section "Configuration"
echo "  (covered by unit tests — tests/config.test.ts: invalid YAML, unknown"
echo "   top-level/nested keys, unset \${VAR}; tests/bundled-config.test.ts)"
assert "startup rejects an invalid config" "1" \
  "$(printf 'nope: true\n' > "$WORK/bad.yaml"; \
     ICEGATE_CONFIG="$WORK/bad.yaml" PORT=18999 npx tsx "$ROOT/src/node.ts" >/dev/null 2>&1; echo $?)"

# --- transparency: PyIceberg + DuckDB --------------------------------------
section "Transparency"
if uv run --quiet --with 'pyiceberg==0.11.1' python "$ROOT/tests-acceptance/pyiceberg_check.py" \
     "$GW1" "$API_KEY" > "$WORK/pyiceberg.log" 2>&1; then
  grep '^pyiceberg:' "$WORK/pyiceberg.log"
  grep '^  ' "$WORK/pyiceberg.log"
  PASSED=$((PASSED + $(grep -c '^  ' "$WORK/pyiceberg.log")))
else
  fail "PyIceberg load_catalog() through the gateway" "$(tail -5 "$WORK/pyiceberg.log")"
fi

# DuckDB reaches the gateway with nothing but an ATTACH: no custom code, no
# rewritten URLs. The count() is a real read — it pulls the table metadata and
# manifest list the catalog handed back.
DUCK_SQL="
INSTALL iceberg; LOAD iceberg;
CREATE SECRET ice (TYPE ICEBERG, TOKEN '$API_KEY');
ATTACH 'omicidx' AS ice (TYPE ICEBERG, ENDPOINT '$GW1');
SELECT schema_name || '.' || table_name FROM duckdb_tables WHERE database_name = 'ice';
SELECT 'rows=' || count(*) FROM ice.geo.samples;
"
DUCK_OUT=$(duckdb -init /dev/null -noheader -list -c "$DUCK_SQL" 2>&1)
assert_contains "DuckDB ATTACH ... TYPE ICEBERG lists the table" "geo.samples" "$DUCK_OUT"
assert_contains "DuckDB queries the table through the gateway" "rows=0" "$DUCK_OUT"

# --- routing ---------------------------------------------------------------
section "Routing"
code=$(status "$GW1/v1/config?warehouse=omicidx")
assert "GET /v1/config?warehouse=omicidx" "200" "$code"
assert "  overrides.prefix = omicidx" "omicidx" "$(jq -r '.overrides.prefix' "$WORK/body.json")"
assert "  overrides.uri = the gateway (no backend bypass)" "$GW1" "$(jq -r '.overrides.uri' "$WORK/body.json")"
assert "  defaults.uri deleted" "null" "$(jq -r '.defaults.uri // "null"' "$WORK/body.json")"
assert "  backend endpoints list forwarded unchanged" "true" \
  "$(jq --argjson b "$(curl -s "$BACKEND/v1/config")" -e '.endpoints == $b.endpoints' "$WORK/body.json" >/dev/null && echo true)"

assert "requests under /v1/omicidx/ reach the backend" "200" "$(status "$GW1/v1/omicidx/namespaces")"
assert "  backend prefix substituted (backend_prefix: bknd)" "400" "$(status "$GW1/v1/prefixed/namespaces")"
assert_contains "  backend saw the substituted path" "v1/bknd/namespaces" "$(cat "$WORK/body.json")"
assert "unknown warehouse → 404" "404" "$(status "$GW1/v1/config?warehouse=nope")"
assert "unknown prefix → 404" "404" "$(status "$GW1/v1/nope/namespaces")"

# --- authentication --------------------------------------------------------
section "Authentication"
assert "anonymous, public namespace (geo) → 200" "200" \
  "$(status "$GW1/v1/omicidx/namespaces/geo/tables")"
assert "anonymous, private namespace → 403" "403" \
  "$(status "$GW1/v1/omicidx/namespaces/private/tables")"
assert "bad API key → 401" "401" \
  "$(status -H "Authorization: Bearer wrong-key" "$GW1/v1/omicidx/namespaces/geo/tables")"
assert "valid API key, private namespace → 200" "200" \
  "$(status -H "Authorization: Bearer $API_KEY" "$GW1/v1/omicidx/namespaces/private/tables")"
assert "anonymous write → 403" "403" \
  "$(status -X POST -H 'Content-Type: application/json' -d '{"namespace":["nope"]}' "$GW1/v1/omicidx/namespaces")"

# --- statelessness ---------------------------------------------------------
section "Statelessness"
identical=true
for path in "/v1/omicidx/namespaces" "/v1/omicidx/namespaces/geo/tables" "/v1/omicidx/namespaces/geo/tables/samples"; do
  a=$(curl -s -H "Authorization: Bearer $API_KEY" "$GW1$path")
  b=$(curl -s -H "Authorization: Bearer $API_KEY" "$GW2$path")
  [ "$a" = "$b" ] || { identical=false; fail "two instances agree on $path" "differed"; }
done
$identical && pass "two instances return identical responses (3 endpoints)"
# /v1/config is compared with `uri` dropped: each instance must advertise its
# own origin, so identical bytes there would be the bug.
a=$(curl -s "$GW1/v1/config?warehouse=omicidx" | jq -S 'del(.overrides.uri)')
b=$(curl -s "$GW2/v1/config?warehouse=omicidx" | jq -S 'del(.overrides.uri)')
assert "two instances agree on /v1/config (minus own origin)" "$a" "$b"

tree_snapshot > "$WORK/tree.after"
assert "no writes to the project tree" "" "$(diff "$WORK/tree.before" "$WORK/tree.after")"

# --- performance -----------------------------------------------------------
section "Performance"
if node "$ROOT/tests-acceptance/perf.mjs" "$GW1/v1/omicidx/namespaces" "$BACKEND/v1/namespaces" > "$WORK/perf.log" 2>&1; then
  grep '^  ' "$WORK/perf.log"
  PASSED=$((PASSED + $(grep -c '^  ' "$WORK/perf.log")))
else
  fail "100 concurrent requests" "$(tail -5 "$WORK/perf.log")"
fi

# --- backend failure (last: it destroys the fixture's in-memory catalog) ----
section "Backend Failure"
$CONTAINER stop -t 2 "$NAME" >/dev/null 2>&1
assert "backend down → 502" "502" "$(status "$GW1/v1/omicidx/namespaces")"
assert "  ErrorModel body" "BadGatewayException" "$(jq -r '.error.type' "$WORK/body.json")"

# --- summary ---------------------------------------------------------------
printf '\n\033[1m%d passed, %d failed\033[0m\n' "$PASSED" "$FAILED"
[ "$FAILED" -eq 0 ]
