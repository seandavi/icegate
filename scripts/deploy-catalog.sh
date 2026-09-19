#!/usr/bin/env bash
# Deploy one catalog's gateway: this checkout's icegate code + the catalog's
# own icegate.yaml (kept in its data repo) as Cloudflare Worker icegate-<name>.
#
# Every run: refuse an uncommitted config (the deployed config must be a git
# state), bake it in as config.yaml (wrangler's Text rule bundles it; restored
# on exit), deploy, verify.
#
# First run only — whichever backend token is missing from Secret Manager is
# minted (bucket-scoped, scripts/create-backend-tokens.sh), archived as
# <name>-cf-vending-ro / -rw, and the four Worker secrets are set:
# CF_ACCOUNT_ID, R2_CATALOG_PREFIX, CF_API_TOKEN_RO, CF_API_TOKEN_RW.
# wrangler refuses `secret put` on a Worker that does not exist, hence
# deploy-then-secrets. Pass --secrets to push the secrets again (rotation).
#
# The bucket and catalog must exist: scripts/new-catalog.sh <name>.
#
# Needs: gcloud access to $GSM_PROJECT, node + npx, curl, python3.
# Usage: scripts/deploy-catalog.sh <name> <path/to/icegate.yaml> [--dry-run|--secrets]
#   env: GSM_PROJECT (default cdsci-infra); TOKEN_MINTER (default: GSM
#        cdsci-cloudflare-token-minter; needs Account API Tokens Write; only
#        read when a token has to be minted)
set -euo pipefail
NAME=${1:?usage: deploy-catalog.sh <name> <icegate.yaml> [--dry-run|--secrets]}
CONFIG=$(realpath "${2:?path to icegate.yaml}")
MODE=${3:-}
WORKER=icegate-$NAME
[ "$WORKER" != icegate ] || { echo "refusing to deploy over the bare 'icegate' Worker" >&2; exit 1; }
PROJECT=${GSM_PROJECT:-cdsci-infra}
cd "$(dirname "$0")/.."

gsm() { gcloud secrets versions access latest --secret "$1" --project "$PROJECT"; }
step() { echo "==> $*"; }

REPO=$(dirname "$CONFIG")
if [ -n "$(git -C "$REPO" status --short "$CONFIG")" ]; then
  echo "$CONFIG has uncommitted changes; commit first so the deployed config is a git state" >&2; exit 1
fi
grep -q "^  $NAME:" "$CONFIG" || { echo "$CONFIG declares no catalog '$NAME'" >&2; exit 1; }
grep -q '\${CF_API_TOKEN_RO}' "$CONFIG" || { echo "$CONFIG lacks \${CF_API_TOKEN_RO}: the default backend token must be the read-only one" >&2; exit 1; }

ACCT=$(gsm cdsci-r2-account-id)
export CLOUDFLARE_API_TOKEN=$(gsm cdsci-cloudflare-workers-token) CLOUDFLARE_ACCOUNT_ID=$ACCT

cp config.yaml "config.yaml.pre-$NAME"
trap 'mv -f "config.yaml.pre-$NAME" config.yaml' EXIT
cp "$CONFIG" config.yaml
step "deploying $CONFIG ($(git -C "$REPO" rev-parse --short HEAD)) as Worker $WORKER"
if [ "$MODE" = --dry-run ]; then
  npx wrangler deploy --name "$WORKER" --dry-run --outdir "$(mktemp -d)"; exit 0
fi
npx wrangler deploy --name "$WORKER"

have() { gcloud secrets describe "$1" --project "$PROJECT" >/dev/null 2>&1; }
MINTED=
for m in ro rw; do
  have "$NAME-cf-vending-$m" && continue
  step "minting icegate-$NAME-$m"
  MINTER=${TOKEN_MINTER:-$(gsm cdsci-cloudflare-token-minter)}
  VALUE=$(CF_ACCOUNT_ID=$ACCT R2_BUCKET=$NAME CLOUDFLARE_API_TOKEN=$MINTER bash scripts/create-backend-tokens.sh $m | cut -d= -f2-)
  [ -n "$VALUE" ] || { echo "minting returned nothing" >&2; exit 1; }
  access=$([ $m = ro ] && echo Read || echo Write)
  # annotation values use ';' — gcloud's dict parser splits on ','
  printf %s "$VALUE" | gcloud secrets create "$NAME-cf-vending-$m" --data-file=- --project "$PROJECT" --replication-policy=automatic \
    --labels="type=api-token,subject=cloudflare,scope=$NAME,managed-by=manual" \
    --set-annotations="purpose=icegate-$NAME backend $m vending token,consumed-by=Worker $WORKER secret CF_API_TOKEN_${m^^},rotated=$(date +%F),cf-token-name=icegate-$NAME-$m,cf-token-type=account,scopes=Workers R2 Data Catalog $access; Workers R2 Storage Bucket Item $access (bucket=$NAME)" >/dev/null
  MINTED=1
done

if [ -n "$MINTED" ] || [ "$MODE" = --secrets ]; then
  step "setting Worker secrets"
  RO=$(gsm "$NAME-cf-vending-ro")
  PREFIX=$(curl -sf -H "Authorization: Bearer $RO" \
    "https://catalog.cloudflarestorage.com/$ACCT/$NAME/v1/config?warehouse=${ACCT}_$NAME" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["overrides"]["prefix"])')
  put() { printf %s "$2" | npx wrangler secret put "$1" --name "$WORKER" >/dev/null && echo "    $1"; }
  put CF_ACCOUNT_ID "$ACCT"
  put R2_CATALOG_PREFIX "$PREFIX"
  put CF_API_TOKEN_RO "$RO"
  put CF_API_TOKEN_RW "$(gsm "$NAME-cf-vending-rw")"
fi

step "verifying"
URL=https://$WORKER.${WORKERS_SUBDOMAIN:-seandavi}.workers.dev
curl -sf "$URL/health" >/dev/null && echo "    /health ok"
curl -sf "$URL/v1/config?warehouse=$NAME" >/dev/null && echo "    /v1/config ok"
curl -sf "$URL/v1/$NAME/namespaces" | python3 -c 'import json,sys; print("    anonymous namespaces:", [n[0] for n in json.load(sys.stdin)["namespaces"]])'
