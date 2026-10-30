#!/usr/bin/env node
/**
 * The baseline ratchet, run on main after every merge ("Performance
 * baselines" workflow): fold main's fresh samples into baselines.json, the
 * file the perf-baselines branch holds and every PR is judged against.
 *
 *   node scripts/perf-baseline.mjs --samples <dir> --baselines <file> --sha <commit>
 *
 * A baseline only ever drops: an SLO's moves to main's new p95 when main
 * is significantly faster than the samples it was set from (Mann–Whitney
 * U, p < 0.05), so a lucky run can't set a bar main can't meet. An SLO
 * with no baseline yet takes main's first measurement. A slower main
 * leaves the baseline where it was, and PRs show it as over budget until
 * someone wins it back.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, pooled, readJson, significantShift, summarize } from "./perf-stats.mjs";

/** The new baseline for one SLO, or null to keep the old one. */
function ratchet(previous, measured) {
  if (!measured) return null;
  if (!previous) return measured;
  const faster =
    measured.p95 < previous.p95 && significantShift(measured.samples, previous.samples) < 0;
  return faster ? measured : null;
}

/** Main's fresh measurement of one SLO, as a baseline would hold it. */
function measurement(runs, id, sha, measuredAt) {
  const summary = summarize(runs, id);
  if (!summary) return null;
  return {
    // Up, so the samples that set it are never over it.
    p95: Math.ceil(summary.p95 * 10) / 10,
    samples: summary.values.map((value) => Math.round(value * 10) / 10),
    sha,
    measuredAt,
  };
}

const shown = (p95) => (p95 === undefined ? "–" : `${p95} ms`);

async function main() {
  const args = parseArgs(
    process.argv.slice(2),
    ["samples", "baselines", "sha"],
    "perf-baseline.mjs --samples <dir> --baselines <file> --sha <commit>",
  );
  const here = path.dirname(fileURLToPath(import.meta.url));
  const config = await readJson(path.join(here, "../tests/perf/slos.json"));
  const baselines = await readJson(args.baselines, {});
  const runs = await pooled(args.samples);
  const measuredAt = new Date().toISOString();

  for (const { id } of config.slos) {
    const measured = measurement(runs, id, args.sha, measuredAt);
    const before = baselines[id];
    baselines[id] = ratchet(before, measured) ?? before;
    console.log(
      `${id}: measured ${shown(measured?.p95)}, baseline ${shown(before?.p95)} → ${shown(baselines[id]?.p95)}`,
    );
  }

  await fs.writeFile(args.baselines, `${JSON.stringify(baselines, null, 2)}\n`);
}

await main();
