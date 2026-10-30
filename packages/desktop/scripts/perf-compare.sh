#!/usr/bin/env bash
# Measure a base build and this checkout's build in alternating rounds
# (base→head, head→base, …, so drift on the machine lands on both), then
# write the SLO report to perf-results/report.md.
#
#   scripts/perf-compare.sh <base packages/desktop dir> [rounds]
#
# Both sides need `scripts/perf-build.sh` run first. Both run this
# checkout's suite, so the scenarios are the same on each side.
set -euo pipefail
head="$(cd "$(dirname "$0")/.." && pwd)"
base="$(cd "$1" && pwd)"
rounds="${2:-3}"
out="$head/perf-results"
rm -rf "$out"

measure() { # <side> <desktop dir> <round>
  echo "::group::$1, round $3"
  PERF_BUILD="$2/perf-build" PERF_OUT="$out/$1/round-$3" \
    npx playwright test --config playwright.perf.config.ts
  echo "::endgroup::"
}

cd "$head"
for round in $(seq 1 "$rounds"); do
  if (( round % 2 )); then
    measure base "$base" "$round"
    measure head "$head" "$round"
  else
    measure head "$head" "$round"
    measure base "$base" "$round"
  fi
done

node scripts/perf-report.mjs --base "$out/base" --head "$out/head" --out "$out/report.md"
