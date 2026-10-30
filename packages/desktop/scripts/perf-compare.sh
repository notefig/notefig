#!/usr/bin/env bash
# Measure a base build and this checkout's build in alternating rounds
# (base→head, head→base, …, so drift on the machine lands on both), then
# write the SLO report to perf-results/report.md.
#
#   scripts/perf-compare.sh <base packages/desktop dir> [rounds]
#
# Both sides need `scripts/perf-build.sh` run first. Both run this
# checkout's suite, so the scenarios are the same on each side; what they
# are judged by is the base's: its slos.json (this checkout's while the
# base has none), and the baselines file PERF_BASELINES names, if any.
set -euo pipefail
head="$(cd "$(dirname "$0")/.." && pwd)"
base="$(cd "$1" && pwd)"
rounds="${2:-3}"
out="$head/perf-results"
rm -rf "$out"

measure() { # <side> <desktop dir> <round>
  echo "::group::$1, round $3"
  scripts/perf-measure.sh "$2" "$out/$1/round-$3"
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

slos="$base/tests/perf/slos.json"
[ -f "$slos" ] || slos="$head/tests/perf/slos.json"
node scripts/perf-report.mjs --base "$out/base" --head "$out/head" --slos "$slos" \
  ${PERF_BASELINES:+--baselines "$PERF_BASELINES"} --out "$out/report.md"
