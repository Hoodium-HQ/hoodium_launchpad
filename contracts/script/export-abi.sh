#!/usr/bin/env sh
# Copy the ABI arrays of the public contracts from forge's build output into
# abi/*.json so the api and web packages can import them without a Solidity
# toolchain. Run after `forge build`. Requires `jq`, or falls back to `forge
# inspect` when jq is missing.
set -eu
cd "$(dirname "$0")/.."
mkdir -p abi
for c in HoodiumFactory BondingCurve LPLocker FeeVault HoodiumToken GraduationManager GraduationHelper; do
  if command -v jq >/dev/null 2>&1; then
    jq '.abi' "out/$c.sol/$c.json" > "abi/$c.json"
  else
    forge inspect "$c" abi --json > "abi/$c.json"
  fi
  echo "abi/$c.json"
done
