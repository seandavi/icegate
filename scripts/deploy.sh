#!/usr/bin/env bash
# Deploy icegate to Cloudflare Workers.
#
# Pulls real infrastructure values from Google Secrets Manager / rclone at
# deploy time and pushes them as Workers secrets — nothing sensitive is
# committed. Requires: gcloud (cdsci-infra access), wrangler, curl, python3.
set -euo pipefail
cd "$(dirname "$0")/.."

CF_ACCOUNT_ID=${CF_ACCOUNT_ID:-$(grep -A3 '^\[r2\]' ~/.config/rclone/rclone.conf | grep -oP '(?<=https://)[0-9a-f]{32}')}
R2_BUCKET=${R2_BUCKET:-omicidx-r2cat-test}
CF_API_TOKEN=$(gcloud secrets versions access latest --secret cdsci-cloudflare-api-token --project cdsci-infra)
export CLOUDFLARE_API_TOKEN=${CLOUDFLARE_API_TOKEN:-$(gcloud secrets versions access latest --secret cdsci-cloudflare-workers-token --project cdsci-infra)}
export CLOUDFLARE_ACCOUNT_ID=$CF_ACCOUNT_ID

# Discover the catalog's stable UUID prefix from its own /v1/config (see #2).
R2_CATALOG_PREFIX=$(curl -sf -H "Authorization: Bearer $CF_API_TOKEN" \
  "https://catalog.cloudflarestorage.com/$CF_ACCOUNT_ID/$R2_BUCKET/v1/config?warehouse=${CF_ACCOUNT_ID}_${R2_BUCKET}" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["overrides"]["prefix"])')

# The Workers bundle imports ../config.yaml; swap in the production config.
# ponytail: swap-and-restore beats a second wrangler config until a second
# environment exists.
cp config.yaml config.dev.yaml.bak
cp config.production.yaml config.yaml
trap 'mv config.dev.yaml.bak config.yaml' EXIT

# Deploy FIRST — `wrangler secret put` refuses a script that doesn't exist
# yet. Config loads lazily per-request, so the brief secretless window only
# affects requests made before the puts below finish.
npx wrangler deploy

for s in CF_ACCOUNT_ID R2_BUCKET CF_API_TOKEN R2_CATALOG_PREFIX; do
  printf '%s' "${!s}" | npx wrangler secret put "$s" >/dev/null
done
