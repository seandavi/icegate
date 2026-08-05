#!/usr/bin/env bash
# Deploy icegate to Cloudflare Workers.
#
# Pulls real infrastructure values from Google Secrets Manager / rclone at
# deploy time and pushes them as Workers secrets — nothing sensitive is
# committed. Requires: gcloud (cdsci-infra access), node/npx, curl, python3.
set -euo pipefail
cd "$(dirname "$0")/.."

step() { echo "==> $*"; }
die() { echo "ERROR: $*" >&2; exit 1; }

step "Resolving account id (cdsci-r2-account-id secret; CF_ACCOUNT_ID env overrides)"
if [ -z "${CF_ACCOUNT_ID:-}" ]; then
  CF_ACCOUNT_ID=$(gcloud secrets versions access latest --secret cdsci-r2-account-id --project cdsci-infra) \
    || die "could not fetch cdsci-r2-account-id — set CF_ACCOUNT_ID and rerun"
fi
echo "    account: ${CF_ACCOUNT_ID:0:6}…"

R2_BUCKET=${R2_BUCKET:-omicidx-r2cat-test}
echo "    bucket:  $R2_BUCKET"

step "Fetching Cloudflare API token from Secrets Manager (cdsci-infra)"
CF_API_TOKEN=$(gcloud secrets versions access latest --secret cdsci-cloudflare-api-token --project cdsci-infra) \
  || die "gcloud failed — are you authenticated (gcloud auth login) with access to cdsci-infra?"

step "Fetching Workers deploy token"
export CLOUDFLARE_API_TOKEN=${CLOUDFLARE_API_TOKEN:-$(gcloud secrets versions access latest --secret cdsci-cloudflare-workers-token --project cdsci-infra)} \
  || die "could not fetch cdsci-cloudflare-workers-token"
export CLOUDFLARE_ACCOUNT_ID=$CF_ACCOUNT_ID

step "Discovering catalog UUID prefix from R2 /v1/config (see issue #2)"
R2_CATALOG_PREFIX=$(curl -sf -H "Authorization: Bearer $CF_API_TOKEN" \
  "https://catalog.cloudflarestorage.com/$CF_ACCOUNT_ID/$R2_BUCKET/v1/config?warehouse=${CF_ACCOUNT_ID}_${R2_BUCKET}" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["overrides"]["prefix"])') \
  || die "could not read the catalog's /v1/config — is the R2 Data Catalog enabled on $R2_BUCKET and the token valid?"
echo "    prefix:  $R2_CATALOG_PREFIX"

step "Swapping in config.production.yaml (restored on exit)"
cp config.yaml config.dev.yaml.bak
cp config.production.yaml config.yaml
trap 'mv config.dev.yaml.bak config.yaml' EXIT

# Deploy FIRST — `wrangler secret put` refuses a script that doesn't exist
# yet. Config loads lazily per-request, so the brief secretless window only
# affects requests made before the puts below finish.
step "wrangler deploy"
npx wrangler deploy

step "Pushing Workers secrets (CF_ACCOUNT_ID R2_BUCKET CF_API_TOKEN R2_CATALOG_PREFIX)"
for s in CF_ACCOUNT_ID R2_BUCKET CF_API_TOKEN R2_CATALOG_PREFIX; do
  printf '%s' "${!s}" | npx wrangler secret put "$s" >/dev/null
  echo "    $s ✓"
done

step "Done — try: curl https://icegate.<your-subdomain>.workers.dev/health"
