#!/usr/bin/env bash
set -euo pipefail

project_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
dist_root="$project_root/dist"

python3 "$project_root/scripts/public_identity_check.py" --root "$project_root" --history all --history-content --require-head-identity
node "$project_root/scripts/verify-vendor.mjs"
python3 "$project_root/scripts/verify-vguard-release.py" --require-apk
python3 "$project_root/scripts/source-archives.py"
node "$project_root/scripts/assemble.mjs"
rm -rf "$dist_root"
mkdir -p "$dist_root/server"
cp "$project_root/worker/index.js" "$dist_root/server/index.js"
# External Worker deployment does not require Sites-specific hosting metadata.
# Preserve it when supplied, but never invent a placeholder configuration.
if [[ -f "$project_root/.openai/hosting.json" ]]; then
  mkdir -p "$dist_root/.openai"
  cp "$project_root/.openai/hosting.json" "$dist_root/.openai/hosting.json"
fi

echo "Built $dist_root"
