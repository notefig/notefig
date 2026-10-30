/**
 * Where a run's samples go: one JSON file per spec under `PERF_OUT`
 * (default `perf-results/local`). `scripts/perf-report.mjs` merges every
 * file under a directory into one set of samples per scenario.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import type { PerfSamples } from "./latency";

export async function saveSamples(
  name: string,
  samples: PerfSamples,
): Promise<void> {
  const dir = process.env.PERF_OUT ?? path.join("perf-results", "local");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, `${name}.json`),
    JSON.stringify(samples, null, 2),
  );
}
