#!/usr/bin/env bash
# One round of the perf suite (tests/perf) against the build in
# <packages/desktop dir>/perf-build, its samples into <out dir>.
#
#   scripts/perf-measure.sh <packages/desktop dir> <out dir>
#
# Runs this checkout's suite, whichever build it measures.
set -euo pipefail
desktop="$(cd "$1" && pwd)"
mkdir -p "$2"
out="$(cd "$2" && pwd)"
cd "$(dirname "$0")/.."
PERF_BUILD="$desktop/perf-build" PERF_OUT="$out" \
  npx playwright test --config playwright.perf.config.ts
