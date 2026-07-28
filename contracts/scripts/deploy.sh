#!/usr/bin/env bash
#
# Builds, deploys, and initializes all 5 LinguaLayer Soroban contracts in the
# order their dependencies require:
#
#   1. QualityOracle   — no dependencies
#   2. DatasetRegistry — no dependencies
#   3. DataCommission  — no dependencies
#   4. RoyaltySplitter — no dependencies (scaffold; admin is a Symbol, not
#                        an Address)
#   5. LicenseRouter   — needs QualityOracle's deployed contract address at
#                        init time, AND needs quality_oracle.wasm to already
#                        exist on disk at *build* time (its lib.rs pulls in
#                        QualityOracle's Client type via `contractimport!`
#                        pointed at that file — this is not expressed as a
#                        normal Cargo dependency, so a plain `cargo build
#                        --workspace` does not guarantee the order and can
#                        fail non-deterministically).
#
# Usage:
#   ./contracts/scripts/deploy.sh
#   NETWORK=testnet SOURCE=my-deployer MIN_STAKE=10000000 ./contracts/scripts/deploy.sh
#
# Env vars:
#   NETWORK    Stellar network to deploy to (default: testnet)
#   SOURCE     stellar-cli identity name to deploy/initialize with. Created
#              and funded automatically if it doesn't exist yet and NETWORK
#              is testnet/futurenet (default: lingualayer-deployer)
#   MIN_STAKE  QualityOracle's minimum curator stake, in stroops
#              (default: 10000000, matching the contract's own default)
#
# Writes deployed contract IDs to contracts/deployments/<network>.env in
# both the apps/web and apps/backend variable-naming conventions.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

NETWORK="${NETWORK:-testnet}"
SOURCE="${SOURCE:-lingualayer-deployer}"
MIN_STAKE="${MIN_STAKE:-10000000}"
WASM_TARGET="wasm32v1-none"
WASM_DIR="target/${WASM_TARGET}/release"
OUT_DIR="contracts/deployments"
OUT_FILE="${OUT_DIR}/${NETWORK}.env"

# Build order doubles as deploy/init order — see the header comment above
# for why QualityOracle must come before LicenseRouter.
PACKAGES=(quality-oracle dataset-registry data-commission royalty-splitter license-router)
declare -A WASM_NAME=(
  [quality-oracle]="quality_oracle"
  [dataset-registry]="dataset_registry"
  [data-commission]="data_commission"
  [royalty-splitter]="royalty_splitter"
  [license-router]="license_router"
)

CLI="stellar"
if ! command -v "$CLI" >/dev/null 2>&1; then
  if command -v soroban >/dev/null 2>&1; then
    CLI="soroban"
  else
    echo "error: neither 'stellar' nor 'soroban' CLI found on PATH." >&2
    echo "Install: https://developers.stellar.org/docs/tools/cli/install-cli" >&2
    exit 1
  fi
fi

echo "==> CLI: $CLI"
echo "==> Network: $NETWORK"
echo "==> Source identity: $SOURCE"

if ! "$CLI" keys address "$SOURCE" >/dev/null 2>&1; then
  echo "==> Identity '$SOURCE' not found — generating one"
  if [[ "$NETWORK" == "testnet" || "$NETWORK" == "futurenet" ]]; then
    "$CLI" keys generate "$SOURCE" --network "$NETWORK" --fund
  else
    "$CLI" keys generate "$SOURCE" --network "$NETWORK"
    echo "warning: '$SOURCE' was not auto-funded on '$NETWORK' — fund it before continuing." >&2
  fi
fi
ADMIN="$("$CLI" keys address "$SOURCE")"
echo "==> Admin address: $ADMIN"

echo "==> Building contracts (in dependency order)"
for pkg in "${PACKAGES[@]}"; do
  echo "  -- $pkg"
  cargo build --target "$WASM_TARGET" --release -p "$pkg"
done

deploy() {
  local pkg="$1"
  local wasm="${WASM_DIR}/${WASM_NAME[$pkg]}.wasm"
  "$CLI" contract deploy \
    --wasm "$wasm" \
    --source-account "$SOURCE" \
    --network "$NETWORK"
}

echo "==> Deploying QualityOracle"
QUALITY_ORACLE_ID="$(deploy quality-oracle)"
echo "    $QUALITY_ORACLE_ID"

echo "==> Deploying DatasetRegistry"
DATASET_REGISTRY_ID="$(deploy dataset-registry)"
echo "    $DATASET_REGISTRY_ID"

echo "==> Deploying DataCommission"
DATA_COMMISSION_ID="$(deploy data-commission)"
echo "    $DATA_COMMISSION_ID"

echo "==> Deploying RoyaltySplitter"
ROYALTY_SPLITTER_ID="$(deploy royalty-splitter)"
echo "    $ROYALTY_SPLITTER_ID"

echo "==> Deploying LicenseRouter"
LICENSE_ROUTER_ID="$(deploy license-router)"
echo "    $LICENSE_ROUTER_ID"

echo "==> Initializing QualityOracle (admin, min_stake=$MIN_STAKE)"
"$CLI" contract invoke --id "$QUALITY_ORACLE_ID" --source-account "$SOURCE" --network "$NETWORK" \
  -- initialize --admin "$ADMIN" --min_stake "$MIN_STAKE"

echo "==> Initializing DatasetRegistry (admin)"
"$CLI" contract invoke --id "$DATASET_REGISTRY_ID" --source-account "$SOURCE" --network "$NETWORK" \
  -- initialize --admin "$ADMIN"

echo "==> Initializing DataCommission (admin)"
"$CLI" contract invoke --id "$DATA_COMMISSION_ID" --source-account "$SOURCE" --network "$NETWORK" \
  -- initialize --admin "$ADMIN"

echo "==> Initializing RoyaltySplitter (admin symbol — scaffold, not an Address)"
"$CLI" contract invoke --id "$ROYALTY_SPLITTER_ID" --source-account "$SOURCE" --network "$NETWORK" \
  -- initialize --admin admin

echo "==> Initializing LicenseRouter (admin, oracle=QualityOracle)"
"$CLI" contract invoke --id "$LICENSE_ROUTER_ID" --source-account "$SOURCE" --network "$NETWORK" \
  -- initialize --admin "$ADMIN" --oracle "$QUALITY_ORACLE_ID"

mkdir -p "$OUT_DIR"
cat > "$OUT_FILE" <<EOF
# Generated by contracts/scripts/deploy.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ)
# Network: $NETWORK | Admin: $ADMIN

# --- apps/backend/.env ---
STELLAR_NETWORK=$NETWORK
DATASET_REGISTRY_CONTRACT_ID=$DATASET_REGISTRY_ID
QUALITY_ORACLE_CONTRACT_ID=$QUALITY_ORACLE_ID
DATA_COMMISSION_CONTRACT_ID=$DATA_COMMISSION_ID

# --- apps/web/.env.local ---
NEXT_PUBLIC_STELLAR_NETWORK=$NETWORK
NEXT_PUBLIC_CONTRACT_DATASET_REGISTRY=$DATASET_REGISTRY_ID
NEXT_PUBLIC_CONTRACT_LICENSE_ROUTER=$LICENSE_ROUTER_ID
NEXT_PUBLIC_CONTRACT_ROYALTY_SPLITTER=$ROYALTY_SPLITTER_ID
NEXT_PUBLIC_CONTRACT_QUALITY_ORACLE=$QUALITY_ORACLE_ID
NEXT_PUBLIC_CONTRACT_DATA_COMMISSION=$DATA_COMMISSION_ID
EOF

echo ""
echo "==> Done. Contract IDs written to $OUT_FILE"
cat "$OUT_FILE"
