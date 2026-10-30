#!/usr/bin/env node
/**
 * The performance SLO report: merges the perf suite's samples
 * (tests/perf, one JSON file per spec per run) and checks each SLO in
 * tests/perf/slos.json — its p95 against its budget and, given a base
 * run, against the base.
 *
 *   node scripts/perf-report.mjs --head <dir> [--base <dir>] [--out <file>]
 *
 * Every JSON file under a directory is one run's samples; all of them are
 * pooled, so a CI job's rounds become one distribution per side.
 *
 * Budgets sit at the measured baseline, so the app may only get faster.
 * The runner's noise moves a p95 too, and that alone must not block a
 * merge, so every verdict against the base needs a Mann–Whitney U test to
 * say the two distributions differ (p < 0.05):
 *
 * - regressed: the p95 rose by more than the tolerance;
 * - over budget: the p95 crossed a budget the base was within, and is
 *   significantly worse than the base (crossing it by noise alone is ok);
 * - improved: significantly better and clear of the budget by more than
 *   the tolerance; the report gives the tighter budget to commit, so the
 *   budgets follow the app down;
 * - over budget on main too: reported, failing only by regressing.
 *
 * With `"enforce": true` in slos.json it exits 1 on any failure; until
 * then it only reports.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MARKER = "<!-- notefig-perf-slos -->";
const ALPHA = 0.05;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) args[argv[i].slice(2)] = argv[i + 1];
  if (!args.head) throw new Error("usage: perf-report.mjs --head <dir> [--base <dir>] [--out <file>]");
  return args;
}

async function jsonFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(entry.parentPath, entry.name));
}

/** Every file's samples under `dir`, pooled per scenario. */
async function pooled(dir) {
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

/** Two-sided Mann–Whitney U p-value, normal approximation, tie-ranked. */
function mannWhitney(a, b) {
  const all = [...a.map((v) => [v, 0]), ...b.map((v) => [v, 1])].sort((x, y) => x[0] - y[0]);
  const ranks = new Array(all.length);
  for (let i = 0; i < all.length; ) {
    let j = i;
    while (j + 1 < all.length && all[j + 1][0] === all[i][0]) j++;
    for (let k = i; k <= j; k++) ranks[k] = (i + j) / 2 + 1;
    i = j + 1;
  }
  const rankA = all.reduce((sum, [, side], i) => (side === 0 ? sum + ranks[i] : sum), 0);
  const u = rankA - (a.length * (a.length + 1)) / 2;
  const mean = (a.length * b.length) / 2;
  const sd = Math.sqrt((a.length * b.length * (a.length + b.length + 1)) / 12);
  if (sd === 0) return 1;
  return 2 * (1 - normalCdf(Math.abs((u - mean) / sd)));
}

function summarize(runs, id) {
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

/** One SLO's verdict: see the header for what each status means. */
function judge(slo, head, base, tolerance) {
  if (!head) return { status: "missing" };
  if (!base) return { status: head.p95 > slo.budgetMs ? "over-budget" : "ok" };
  const change = (head.p95 - base.p95) / base.p95;
  const pValue = mannWhitney(head.values, base.values);
  const shift = pValue < ALPHA ? change : 0;
  const status =
    head.p95 > slo.budgetMs
      ? overBudget(shift, base.p95 > slo.budgetMs, tolerance)
      : withinBudget(shift, head.p95 < slo.budgetMs * (1 - tolerance), tolerance);
  return { status, change, pValue };
}

/** `shift`: the p95's relative change against the base when significant,
 *  else 0. */
function overBudget(shift, baseOver, tolerance) {
  if (shift > tolerance) return "regressed";
  if (baseOver) return "inherited";
  return shift > 0 ? "over-budget" : "ok";
}

function withinBudget(shift, clear, tolerance) {
  if (shift > tolerance) return "regressed";
  return shift < 0 && clear ? "improved" : "ok";
}

const ICON = {
  ok: "✅",
  improved: "🎉",
  "over-budget": "❌",
  regressed: "⚠️",
  inherited: "🟠",
  missing: "❔",
};
const LABEL = {
  ok: "",
  improved: "improved",
  "over-budget": "over budget",
  regressed: "regressed",
  inherited: "over budget on main too",
  missing: "no samples",
};
const PASSING = new Set(["ok", "improved", "inherited"]);

const ms = (value) => `${value.toFixed(value < 100 ? 1 : 0)} ms`;

function formatChange({ change, pValue }) {
  if (change === undefined) return "–";
  const sign = change >= 0 ? "+" : "";
  const noise = pValue < ALPHA ? "" : " (noise)";
  return `${sign}${(change * 100).toFixed(1)}%${noise}`;
}

/** `format` of a side's summary, or a dash for a side with no samples. */
const cell = (summary, format) => (summary ? format(summary) : "–");

/** The budget an improvement earns: the new p95, to commit in slos.json. */
const tightened = (slo, head, verdict) =>
  verdict.status === "improved"
    ? ` → **${Math.ceil(head.p95)} ms** (\`${slo.id}\` in slos.json)`
    : "";

function row(slo, head, base, verdict) {
  return [
    `${ICON[verdict.status]} ${LABEL[verdict.status]}`.trim(),
    slo.title,
    `${slo.budgetMs} ms${tightened(slo, head, verdict)}`,
    cell(base, (s) => ms(s.p95)),
    cell(head, (s) => ms(s.p95)),
    formatChange(verdict),
    cell(head, (s) => ms(s.p50)),
    String(head?.n ?? 0),
    cell(head, (s) => s.longTasksPerSample.toFixed(2)),
  ];
}

function render(config, rows, failing, hasBase) {
  const mode = config.enforce
    ? failing
      ? "**Failing**: an SLO regressed or went over budget."
      : "All SLOs pass."
    : "_Report only: not gating merges yet._";
  const table = [
    "| | SLO | Budget (p95) | main p95 | PR p95 | Δ p95 | PR p50 | n | Long tasks / sample |",
    "|---|---|---|---|---|---|---|---|---|",
    ...rows.map((cells) => `| ${cells.join(" | ")} |`),
  ];
  return [
    MARKER,
    "## Performance SLOs",
    "",
    mode,
    "",
    ...table,
    "",
    "<details><summary>How these are measured</summary>",
    "",
    "- Production build against the release `test-shim` (the real Rust backend on a real filesystem), headless Chromium.",
    "- Keystrokes: input to next paint, from the keydown's timestamp to the first task after the next frame, typed at 80 ms intervals.",
    "- Workspace open: a fresh app load, from opening the workspace to the first frame with README.md editable.",
    `- ${hasBase ? "main and this PR are built and measured in the same job, in alternating rounds; samples are pooled per side." : "No base run: budgets only."}`,
    `- Budgets are the measured baseline: the app may only get faster. Each verdict against main needs a Mann–Whitney U test at p < ${ALPHA}.`,
    `- ⚠️ regressed: p95 up more than ${(config.regressionTolerance * 100).toFixed(0)}%. ❌ over budget: p95 past a budget main was within, and worse than main. 🟠 over budget on main too: fails only by regressing.`,
    "- 🎉 improved: significantly faster than main and clear of the budget. Lower the budget to the one shown, in this PR, so the next one can't give it back.",
    "- Long tasks: main-thread tasks of 50 ms or more, per sample.",
    "- Suite and budgets: `packages/desktop/tests/perf/`.",
    "",
    "</details>",
    "",
  ].join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const here = path.dirname(fileURLToPath(import.meta.url));
  const config = JSON.parse(
    await fs.readFile(args.slos ?? path.join(here, "../tests/perf/slos.json"), "utf8"),
  );
  const head = await pooled(args.head);
  const base = args.base ? await pooled(args.base) : null;

  let failing = false;
  const rows = config.slos.map((slo) => {
    const h = summarize(head, slo.id);
    const b = base ? summarize(base, slo.id) : null;
    const verdict = judge(slo, h, b, config.regressionTolerance);
    if (!PASSING.has(verdict.status)) failing = true;
    return row(slo, h, b, verdict);
  });

  const report = render(config, rows, failing, Boolean(base));
  if (args.out) await fs.writeFile(args.out, report);
  process.stdout.write(report);
  if (config.enforce && failing) process.exitCode = 1;
}

await main();
