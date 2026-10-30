#!/usr/bin/env bash
# Build what the perf suite (tests/perf) measures, for the checkout whose
# packages/desktop is $1 (default: this one), into its perf-build/:
#   perf-build/dist       the production bundle, in shim mode (test seams in)
#   perf-build/test-shim  the release-built real backend
# Honors CARGO_TARGET_DIR, so two checkouts can share one Rust build.
set -euo pipefail
desktop="$(cd "${1:-$(dirname "$0")/..}" && pwd)"
cd "$desktop"
out="$desktop/perf-build"
rm -rf "$out"
mkdir -p "$out"

VITE_TEST_BACKEND=shim \
VITE_TEST_BACKEND_PORT=4599 \
VITE_TEST_HOST_OS="$(node -p process.platform)" \
VITE_TELEMETRY_DISABLED=1 \
  npx vite build --outDir "$out/dist" --emptyOutDir

# The Tauri crate's build script needs the sidecars to exist.
node scripts/build-sidecars.mjs
(cd src-tauri && cargo build --release -p test-shim)
target="${CARGO_TARGET_DIR:-$desktop/src-tauri/target}"
cp "$target/release/test-shim" "$out/test-shim"
