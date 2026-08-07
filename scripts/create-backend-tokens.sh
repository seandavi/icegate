#!/usr/bin/env bash
# Mint the two bucket-scoped backend tokens icegate uses upstream (issue #34):
#
#   icegate-<bucket>-ro   Workers R2 Data Catalog Read  (account)
#                       + Workers R2 Storage Bucket Item Read  (<bucket> only)
#   icegate-<bucket>-rw   Workers R2 Data Catalog Write (account)
#                       + Workers R2 Storage Bucket Item Write (<bucket> only)
#
# The dashboard R2 presets (Admin Read / Admin Read & Write) are account-wide
# on both halves and cannot express a bucket-scoped storage half — these
# tokens only exist via the token API. Values are printed ONCE and are not
# retrievable later; store them where scripts/deploy.sh reads them
# (Secrets Manager: cdsci-cloudflare-api-token-ro / -rw).
#
# Requires: curl, python3, CF_ACCOUNT_ID, R2_BUCKET, and CLOUDFLARE_API_TOKEN
# holding "Account API Tokens Write".
set -euo pipefail

: "${CF_ACCOUNT_ID:?set CF_ACCOUNT_ID}"
: "${R2_BUCKET:?set R2_BUCKET (no default — this decides what the tokens can reach)}"
: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN (needs Account API Tokens Write)}"
export CF_ACCOUNT_ID R2_BUCKET

API="https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/tokens"

cf() { curl -sf -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" "$@"; }

GROUPS_JSON=$(cf "$API/permission_groups")

gid() { # permission group name -> id (ids are stable but undocumented; resolve, don't hardcode)
  printf '%s' "$GROUPS_JSON" | python3 -c '
import json, sys
name = sys.argv[1]
groups = {g["name"]: g["id"] for g in json.load(sys.stdin)["result"]}
if name not in groups:
    sys.exit(f"permission group not found: {name!r} — have: {sorted(groups)}")
print(groups[name])
' "$1"
}

create() { # <token name> <catalog permission group> <storage permission group>
  local catalog_gid storage_gid body
  catalog_gid=$(gid "$2")
  storage_gid=$(gid "$3")
  body=$(python3 - "$1" "$catalog_gid" "$storage_gid" <<'PY'
import json, os, sys
name, catalog, storage = sys.argv[1:4]
acct, bucket = os.environ["CF_ACCOUNT_ID"], os.environ["R2_BUCKET"]
print(json.dumps({
    "name": name,
    "policies": [
        # Catalog REST access: account-scoped (R2 offers nothing narrower).
        {"effect": "allow",
         "resources": {f"com.cloudflare.api.account.{acct}": "*"},
         "permission_groups": [{"id": catalog}]},
        # Storage half — what vended credentials inherit: one bucket only.
        {"effect": "allow",
         "resources": {f"com.cloudflare.edge.r2.bucket.{acct}_default_{bucket}": "*"},
         "permission_groups": [{"id": storage}]},
    ],
}))
PY
)
  cf -X POST "$API" --data "$body" | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["value"])'
}

echo "CF_API_TOKEN_RO=$(create "icegate-$R2_BUCKET-ro" "Workers R2 Data Catalog Read" "Workers R2 Storage Bucket Item Read")"
echo "CF_API_TOKEN_RW=$(create "icegate-$R2_BUCKET-rw" "Workers R2 Data Catalog Write" "Workers R2 Storage Bucket Item Write")"
