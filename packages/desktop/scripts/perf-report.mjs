#!/usr/bin/env node
/**
 * The performance SLO report on a PR: each SLO in slos.json, the PR's p95
 * against main's measured beside it, and against main's baseline.
 *
 *   node scripts/perf-report.mjs --head <dir> [--base <dir>]
 *     [--slos <slos.json>] [--baselines <baselines.json>] [--out <file>]
 *
 * Every JSON file under a directory is one run's samples; all of them are
 * pooled, so a CI job's rounds become one distribution per side.
 *
 * Nothing in the PR sets what it is judged against. CI passes main's
 * slos.json (which SLOs, the tolerance, whether a failure fails the job)
 * and the baselines from the perf-baselines branch, which only the
 * post-merge workflow writes (scripts/perf-baseline.mjs), and only ever
 * lower. The baseline is each SLO's budget: the app may only get faster.
 *
 * The runner's noise moves a p95 too, and that alone must not fail a PR,
 * so every verdict against main needs a Mann–Whitney U test to say the
 * PR's distribution moved (p < 0.05) the same way as its p95:
 *
 * - regressed: the p95 rose by more than the tolerance;
 * - over budget: the p95 crossed a baseline main was within, and is
 *   significantly worse than main (crossing it by noise alone is ok);
 * - improved: significantly faster than main and clear of the baseline by
 *   more than the tolerance; the post-merge run lowers the baseline;
 * - over budget on main too: reported, failing only by regressing.
 *
 * With `"enforce": true` the job fails on any failure. It is not a
 * required check: a deliberate slowdown merges red, and the baseline it
 * missed stays where it was.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ALPHA, parseArgs, pooled, readJson, significantShift, summarize } from "./perf-stats.mjs";

const MARKER = "<!-- notefig-perf-slos -->";

/**
 * One SLO's verdict (see the header for what each status means). An SLO
 * with no baseline yet (new, or before the first post-merge run) is judged
 * against main alone.
 */
function judge(budget, head, base, tolerance) {
  if (!head) return { status: "missing" };
  if (!base) return { status: head.p95 > budget ? "over-budget" : "ok" };
  const change = (head.p95 - base.p95) / base.p95;
  const significant = Math.sign(change) === significantShift(head.values, base.values);
  const shift = significant ? change : 0;
  const status =
    head.p95 > budget
      ? overBudget(shift, base.p95 > budget, tolerance)
      : withinBudget(shift, head.p95 < budget * (1 - tolerance), tolerance);
  return { status, change, significant };
}

/** `shift`: the p95's relative change against the base when the
 *  distribution moved the same way, else 0. */
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

function formatChange({ change, significant }) {
  if (change === undefined) return "–";
  const sign = change >= 0 ? "+" : "";
  const noise = significant ? "" : " (noise)";
  return `${sign}${(change * 100).toFixed(1)}%${noise}`;
}

/** `format` of a side's summary, or a dash for a side with no samples. */
const cell = (summary, format) => (summary ? format(summary) : "–");

function row(slo, budget, head, base, verdict) {
  return [
    `${ICON[verdict.status]} ${LABEL[verdict.status]}`.trim(),
    slo.title,
    Number.isFinite(budget) ? ms(budget) : "–",
    cell(base, (s) => ms(s.p95)),
    cell(head, (s) => ms(s.p95)),
    formatChange(verdict),
    cell(head, (s) => ms(s.p50)),
    String(head?.n ?? 0),
    cell(head, (s) => s.longTasksPerSample.toFixed(2)),
  ];
}

function headline(config, failing) {
  if (!config.enforce) return "_Report only: not failing the job._";
  return failing
    ? "**Failing**: an SLO regressed or went over its baseline. This check isn't required: a deliberate slowdown can merge, and the baseline stays where it was."
    : "All SLOs pass.";
}

function render(config, rows, failing, hasBase) {
  const table = [
    "| | SLO | Baseline (p95) | main p95 | PR p95 | Δ p95 | PR p50 | n | Long tasks / sample |",
    "|---|---|---|---|---|---|---|---|---|",
    ...rows.map((cells) => `| ${cells.join(" | ")} |`),
  ];
  return [
    MARKER,
    "## Performance SLOs",
    "",
    headline(config, failing),
    "",
    ...table,
    "",
    "<details><summary>How these are measured</summary>",
    "",
    "- Production build against the release `test-shim` (the real Rust backend on a real filesystem), headless Chromium.",
    "- Keystrokes: input to next paint, from the keydown's timestamp to the first task after the next frame, typed at 80 ms intervals.",
    "- Workspace open: a fresh app load, from opening the workspace to the first frame with README.md editable.",
    `- ${hasBase ? "main and this PR are built and measured in the same job, in alternating rounds; samples are pooled per side." : "No base run: baselines only."}`,
    "- Baseline: main's p95 as measured after a merge, on the `perf-baselines` branch. Only the post-merge workflow writes it, and only lower: when main is significantly faster than the stored samples.",
    `- Each verdict against main needs a Mann–Whitney U test at p < ${ALPHA} that the PR's samples moved the same way as its p95; a p95 moved by a few outliers alone is noise. ⚠️ regressed: p95 up more than ${(config.regressionTolerance * 100).toFixed(0)}%. ❌ over budget: p95 past a baseline main was within, and worse than main. 🟠 over budget on main too: fails only by regressing. 🎉 improved: faster than main and clear of the baseline; it drops once this merges.`,
    "- Long tasks: main-thread tasks of 50 ms or more, per sample.",
    "- SLOs: `packages/desktop/tests/perf/` (read from main, so a PR doesn't set its own).",
    "",
    "</details>",
    "",
  ].join("\n");
}

/** Each SLO's table row, and whether any of them fails. */
function verdicts(config, baselines, head, base) {
  let failing = false;
  const rows = config.slos.map((slo) => {
    const budget = baselines[slo.id]?.p95 ?? Infinity;
    const h = summarize(head, slo.id);
    const b = base && summarize(base, slo.id);
    const verdict = judge(budget, h, b, config.regressionTolerance);
    if (!PASSING.has(verdict.status)) failing = true;
    return row(slo, budget, h, b, verdict);
  });
  return { rows, failing };
}

/** What the report reads: the SLOs, the baselines and both sides' samples. */
async function load(args) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return {
    config: await readJson(args.slos ?? path.join(here, "../tests/perf/slos.json")),
    baselines: args.baselines ? await readJson(args.baselines, {}) : {},
    head: await pooled(args.head),
    base: args.base ? await pooled(args.base) : null,
  };
}

async function main() {
  const args = parseArgs(
    process.argv.slice(2),
    ["head"],
    "perf-report.mjs --head <dir> [--base <dir>] [--slos <file>] [--baselines <file>] [--out <file>]",
  );
  const { config, baselines, head, base } = await load(args);
  const { rows, failing } = verdicts(config, baselines, head, base);
  const report = render(config, rows, failing, Boolean(base));
  if (args.out) await fs.writeFile(args.out, report);
  process.stdout.write(report);
  process.exitCode = config.enforce && failing ? 1 : 0;
}

await main();
