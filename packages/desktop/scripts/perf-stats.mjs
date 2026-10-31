/**
 * What the perf scripts share: reading the suite's samples
 * (tests/perf, one JSON file per spec per run) and the statistics both the
 * PR report and the baseline ratchet judge them by.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

/** Significance for every "faster" or "slower" verdict. */
export const ALPHA = 0.05;

/** `--name value` pairs; `required` names must be present. */
export function parseArgs(argv, required, usage) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) args[argv[i].slice(2)] = argv[i + 1];
  for (const name of required) if (!args[name]) throw new Error(`usage: ${usage}`);
  return args;
}

export async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (fallback !== undefined && error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function jsonFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(entry.parentPath, entry.name));
}

/** Every file's samples under `dir`, pooled per scenario. */
export async function pooled(dir) {
  const latency = {};
  const longTasks = {};
  for (const file of await jsonFiles(dir)) {
    const samples = JSON.parse(await fs.readFile(file, "utf8"));
    for (const [id, values] of Object.entries(samples.latency))
      (latency[id] ??= []).push(...values);
    for (const [id, values] of Object.entries(samples.longTasks))
      (longTasks[id] ??= []).push(...values);
  }
  return { latency, longTasks };
}

/** Nearest-rank percentile. */
function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
}

/** Standard normal CDF (Abramowitz–Stegun 7.1.26 via erf). */
function normalCdf(z) {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const poly =
    t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - poly * Math.exp(-(z * z) / 2);
  return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

/**
 * Which way `a` is shifted from `b`: 1 if its values run significantly
 * higher, -1 if lower, 0 if the two can't be told apart. A two-sided
 * Mann–Whitney U test (normal approximation, tie-ranked) at p < ALPHA;
 * the sign says which side the significance is on, so a p95 that moved
 * one way on a few outliers isn't read as the whole distribution moving.
 */
export function significantShift(a, b) {
  const z = uScore(a, b);
  return 2 * (1 - normalCdf(Math.abs(z))) < ALPHA ? Math.sign(z) : 0;
}

/** The U statistic of `a` against `b` as a z-score; 0 when it's undefined. */
function uScore(a, b) {
  const all = [...a.map((v) => [v, 0]), ...b.map((v) => [v, 1])].sort((x, y) => x[0] - y[0]);
  const ranks = tieRanks(all.map(([value]) => value));
  const rankA = all.reduce((sum, [, side], i) => (side === 0 ? sum + ranks[i] : sum), 0);
  const u = rankA - (a.length * (a.length + 1)) / 2;
  const mean = (a.length * b.length) / 2;
  const sd = Math.sqrt((a.length * b.length * (a.length + b.length + 1)) / 12);
  return sd === 0 ? 0 : (u - mean) / sd;
}

/** 1-based ranks of sorted `values`, ties sharing their average rank. */
function tieRanks(values) {
  const ranks = new Array(values.length);
  for (let i = 0; i < values.length; ) {
    let j = i;
    while (j + 1 < values.length && values[j + 1] === values[i]) j++;
    ranks.fill((i + j) / 2 + 1, i, j + 1);
    i = j + 1;
  }
  return ranks;
}

export function summarize(runs, id) {
  const values = runs.latency[id] ?? [];
  if (values.length === 0) return null;
  return {
    values,
    n: values.length,
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    longTasksPerSample: (runs.longTasks[id]?.length ?? 0) / values.length,
  };
}

