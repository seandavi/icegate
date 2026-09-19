#!/usr/bin/env bash
# Stand up the storage side of a new icegate-fronted catalog, idempotently:
#
#   1. R2 bucket <name>
#   2. bucket CORS policy (GET/HEAD from any origin) — browser clients such as
#      DuckDB-WASM read data files straight from R2; icegate's own CORS covers
#      catalog metadata only
#   3. R2 Data Catalog enabled on the bucket
#   4. two icegate API keys — `<operator>` (read+write) and `<operator>-ro` —
#      plaintext to Google Secret Manager as <name>-icegate-key-<principal>
#   5. a starter icegate.yaml on stdout, with the key digests filled in
#
# Then: save the yaml in the data repo, commit it, and run
#   scripts/deploy-catalog.sh <name> <path/to/icegate.yaml>
# which deploys Worker icegate-<name> and, on first run, mints the
# bucket-scoped backend tokens and sets the Worker secrets.
#
# One Worker per catalog, on purpose: an anonymous-enabled config never shares
# a file — or a blast radius — with another catalog's.
#
# Uses the REST API rather than wrangler for steps 1–3 so it does not depend on
# the pinned wrangler knowing `r2 bucket catalog`.
#
# Needs: curl, python3, node, gcloud with access to $GSM_PROJECT.
# Usage: scripts/new-catalog.sh <name> [namespace ...]
#   env: LOCATION (default wnam), OPERATOR (default $USER), GSM_PROJECT
#        (default cdsci-infra), CLOUDFLARE_API_TOKEN (default: GSM
#        cdsci-cloudflare-api-token; needs R2 Edit), CF_ACCOUNT_ID (default:
#        GSM cdsci-r2-account-id)
set -euo pipefail
NAME=${1:?usage: new-catalog.sh <name> [namespace ...]}; shift
case $NAME in */*|config) echo "catalog name must not contain '/' or be 'config'" >&2; exit 1;; esac
NAMESPACES=("${@:-provenance raw}")
LOCATION=${LOCATION:-wnam}
OPERATOR=${OPERATOR:-$USER}
PROJECT=${GSM_PROJECT:-cdsci-infra}

gsm() { gcloud secrets versions access latest --secret "$1" --project "$PROJECT"; }
step() { echo "==> $*" >&2; }
ACCT=${CF_ACCOUNT_ID:-$(gsm cdsci-r2-account-id)}
TOKEN=${CLOUDFLARE_API_TOKEN:-$(gsm cdsci-cloudflare-api-token)}
API=https://api.cloudflare.com/client/v4/accounts/$ACCT
cf() { curl -s -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' "$@"; }
ok() { python3 -c 'import json,sys; d=json.load(sys.stdin); sys.exit(0 if d.get("success") else "    "+json.dumps(d.get("errors")))'; }

step "bucket $NAME ($LOCATION)"
if cf "$API/r2/buckets/$NAME" | ok 2>/dev/null; then echo "    exists" >&2
else cf -X POST "$API/r2/buckets" --data "{\"name\":\"$NAME\",\"locationHint\":\"$LOCATION\"}" | ok; fi

step "CORS policy"
cf -X PUT "$API/r2/buckets/$NAME/cors" --data '{"rules":[{"allowed":{"origins":["*"],"methods":["GET","HEAD"],"headers":["*"]},"exposeHeaders":["ETag","Content-Length","Content-Range","Accept-Ranges"],"maxAgeSeconds":3600}]}' | ok

step "R2 Data Catalog"
if [ "$(cf "$API/r2-catalog/$NAME" | python3 -c 'import json,sys; print((json.load(sys.stdin).get("result") or {}).get("status"))')" = active ]; then echo "    already active" >&2
else cf -X POST "$API/r2-catalog/$NAME/enable" | ok; fi

step "icegate API keys → Secret Manager ($PROJECT)"
digest() { # principal, permission summary -> sha256 of the key (minted if absent)
  local secret=$NAME-icegate-key-$1
  if ! gcloud secrets describe "$secret" --project "$PROJECT" >/dev/null 2>&1; then
    node -e 'const a="0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz",b=crypto.getRandomValues(new Uint8Array(32));process.stdout.write("icegate_"+[...b].map(x=>a[x%62]).join(""))' \
      | gcloud secrets create "$secret" --data-file=- --project "$PROJECT" --replication-policy=automatic \
          --labels="type=api-key,subject=icegate,scope=$NAME,managed-by=manual" \
          --set-annotations="purpose=icegate-$NAME $2 key for principal $1; only its sha256 is in the catalog's icegate.yaml,consumed-by=$NAME clients,rotated=$(date +%F)" >/dev/null
    echo "    minted $secret" >&2
  else echo "    $secret exists" >&2; fi
  gsm "$secret" | sha256sum | cut -d' ' -f1
}
RW_DIGEST=$(digest "$OPERATOR" "read+write")
RO_DIGEST=$(digest "$OPERATOR-ro" "read-only")

step "starter icegate.yaml on stdout"
ns() { for n in ${NAMESPACES[*]}; do echo "$1- $n"; done; }
cat <<YAML
# icegate configuration for the $NAME catalog — Worker \`icegate-$NAME\`.
# \${VARS} resolve from Workers secrets at deploy time; no infrastructure
# identifiers are committed here.

cors:
  enabled: true
  origins:
    - "*"

authentication:
  # Namespaces and permissions MUST stay explicit: absent lists default to
  # empty, which grants nothing. Anonymous read is safe only because the
  # default backend token is read-only and scoped to this one bucket.
  anonymous:
    enabled: true
    namespaces:
$(ns "      ")
    permissions:
      - read

  api_keys:
    enabled: true

    # Ingest key; plaintext in Secret Manager $NAME-icegate-key-$OPERATOR.
    $OPERATOR:
      sha256: $RW_DIGEST
      namespaces:
$(ns "        ")
      permissions:
        - read
        - write

    # Read-only key; plaintext in Secret Manager $NAME-icegate-key-$OPERATOR-ro.
    $OPERATOR-ro:
      sha256: $RO_DIGEST
      namespaces:
$(ns "        ")
      permissions:
        - read

catalogs:
  $NAME:
    endpoint: https://catalog.cloudflarestorage.com/\${CF_ACCOUNT_ID}/$NAME
    backend_warehouse: \${CF_ACCOUNT_ID}_$NAME
    backend_prefix: \${R2_CATALOG_PREFIX}
    auth:
      bearer_token: \${CF_API_TOKEN_RO}
      bearer_token_write: \${CF_API_TOKEN_RW}
    capabilities:
      read: true
      write: true
YAML
