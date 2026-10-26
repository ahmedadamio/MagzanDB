#!/usr/bin/env bash
# Rebuild the wasm-bindgen bridge and stage artifacts into adapter/dist/.
set -euo pipefail
cd "$(dirname "$0")/.."

cargo build -p pglite-bridge --target wasm32-unknown-unknown --release
wasm-bindgen --target web --out-dir adapter/dist \
  target/wasm32-unknown-unknown/release/pglite_bridge.wasm
echo "bridge artifacts staged in adapter/dist/"
