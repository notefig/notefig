// @vitest-environment node
/**
 * Corpus run for the merge prototype (MET-271 step 1b). Takes the repo's
 * tracked markdown files as bases, generates concurrent edit pairs with a
 * seeded PRNG, merges each pair and tallies: validation failures (grouped),
 * conflict markers, determinism failures, and, where the scenario has one
 * right answer, results that are valid but differ from it.
 *
 * Slow (a few thousand merges), so it only runs when asked:
 *   MERGE_CORPUS=1 npx vitest run src/modules/sync/merge/merge.corpus.test.ts
 * MERGE_CORPUS_PAIRS sets the pairs per scenario per base (default 3);
 * MERGE_CORPUS_OUT writes the JSON report to that path.
 *
 * Runs in the node environment over the conversion worker's linkedom DOM
 * shim, as the merge will in the sync worker (happy-dom's parsed documents
 * pile up over thousands of parses and exhaust the heap).
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installWorkerDomShim } from "@/workers/worker-dom-shim";
import { createMarkdownCodec } from "@/components/editor/markdown-codec";
import { createMarkdownMerge, type Holder, type MergeResult } from "./merge";
import { splitBlocks } from "./blocks";
import { sourceSpans } from "./source-spans";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../../..");
const PAIRS = Number(process.env.MERGE_CORPUS_PAIRS ?? 3);

// ---------------------------------------------------------------------------
// Seeded randomness

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rng = () => number;
const WORDS = ["alpha", "brisk", "cedar", "delta", "ember", "fjord", "gamut", "harbor", "indigo", "juniper", "kestrel", "lumen"];
const int = (rng: Rng, n: number) => Math.floor(rng() * n);
const pick = <T,>(rng: Rng, xs: T[]): T => xs[int(rng, xs.length)];
const words = (rng: Rng, tag: string) =>
  `${tag}${pick(rng, WORDS)} ${pick(rng, WORDS)}`;

// ---------------------------------------------------------------------------
// Blocks and edits, in base coordinates

type Kind = "frontmatter" | "heading" | "code" | "table" | "list" | "quote" | "hr" | "html" | "paragraph";

function kindOf(block: string, index: number): Kind {
  if (index === 0 && block.startsWith("---\n")) return "frontmatter";
  if (/^#{1,6} /.test(block)) return "heading";
  if (/^(```|~~~)/.test(block)) return "code";
  if (block.startsWith("|")) return "table";
  if (/^\s*([-*+]|\d+[.)]) /.test(block)) return "list";
  if (block.startsWith(">")) return "quote";
  if (/^(-{3,}|\*{3,}|_{3,})$/.test(block)) return "hr";
  if (block.startsWith("<")) return "html";
  return "paragraph";
}

/** Replace `del` blocks at `at` with `insert`. */
interface Op {
  at: number;
  del: number;
  insert: string[];
}

function apply(blocks: string[], ops: Op[]): string[] {
  const out = [...blocks];
  // Descending, and an edit/delete before an insert at the same index, so
  // an insert at i lands before whatever ends up at i.
  for (const op of [...ops].sort((x, y) => y.at - x.at || y.del - x.del)) {
    out.splice(op.at, op.del, ...op.insert);
  }
  return out;
}

/** Word-boundary offsets in `text` (before a space, or the end). */
function boundaries(text: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) if (text[i] === " ") out.push(i);
  out.push(text.length);
  return out;
}

const insertAt = (text: string, at: number, s: string) =>
  text.slice(0, at) + s + text.slice(at);

/** Type a few words at a word boundary of a heading or paragraph. */
function typeIn(rng: Rng, block: string, tag: string): string {
  const lines = block.split("\n");
  const li = int(rng, lines.length);
  const at = pick(rng, boundaries(lines[li]));
  lines[li] = insertAt(lines[li], at, ` ${words(rng, tag)}`);
  return lines.join("\n");
}

const ITEM = /^(\s*)([-*+]|\d+[.)]) (\[[ xX]\] )?/;

function listItemLines(block: string): number[] {
  return block.split("\n").flatMap((l, i) => (ITEM.test(l) ? [i] : []));
}

function editListItem(rng: Rng, block: string, tag: string, line?: number): string {
  const lines = block.split("\n");
  const li = line ?? pick(rng, listItemLines(block));
  lines[li] += ` ${words(rng, tag)}`;
  return lines.join("\n");
}

function tableCells(block: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  block.split("\n").forEach((line, r) => {
    if (r === 1 || !line.startsWith("|")) return;
    const cells = line.split("|").length - 2;
    for (let c = 0; c < cells; c++) out.push([r, c]);
  });
  return out;
}

function editTableCell(rng: Rng, block: string, tag: string, cell?: [number, number]): string {
  const lines = block.split("\n");
  const [r, c] = cell ?? pick(rng, tableCells(block));
  const parts = lines[r].split("|");
  parts[c + 1] = ` ${parts[c + 1].trim()} ${words(rng, tag)} `;
  lines[r] = parts.join("|");
  return lines.join("\n");
}

function codeAddLine(rng: Rng, block: string, tag: string): string {
  const lines = block.split("\n");
  const at = 1 + int(rng, Math.max(1, lines.length - 2));
  lines.splice(at, 0, `// ${words(rng, tag)}`);
  return lines.join("\n");
}

/** One in-place edit of block `i`, or null if its kind has none. */
function editBlock(rng: Rng, blocks: string[], i: number, tag: string): Op | null {
  const block = blocks[i];
  switch (kindOf(block, i)) {
    case "heading":
    case "paragraph":
    case "quote":
      return { at: i, del: 1, insert: [typeIn(rng, block, tag)] };
    case "list":
      return listItemLines(block).length
        ? { at: i, del: 1, insert: [editListItem(rng, block, tag)] }
        : null;
    case "table":
      return tableCells(block).length
        ? { at: i, del: 1, insert: [editTableCell(rng, block, tag)] }
        : null;
    case "code":
      return { at: i, del: 1, insert: [codeAddLine(rng, block, tag)] };
    default:
      return null;
  }
}

function editableIndices(blocks: string[]): number[] {
  return blocks.flatMap((b, i) =>
    ["heading", "paragraph", "quote", "list", "table", "code"].includes(kindOf(b, i)) ? [i] : [],
  );
}

const newBlock = (rng: Rng, tag: string) => `New ${words(rng, tag)} paragraph.`;

/** A random op anywhere: edit, insert or delete. */
function randomOp(rng: Rng, blocks: string[], tag: string): Op | null {
  const r = rng();
  if (r < 0.2) return { at: int(rng, blocks.length + 1), del: 0, insert: [newBlock(rng, tag)] };
  if (r < 0.35 && blocks.length > 1) {
    const at = int(rng, blocks.length);
    return kindOf(blocks[at], at) === "frontmatter" ? null : { at, del: 1, insert: [] };
  }
  const editable = editableIndices(blocks);
  return editable.length ? editBlock(rng, blocks, pick(rng, editable), tag) : null;
}

// ---------------------------------------------------------------------------
// Scenarios: each returns ours/theirs ops and, when there is exactly one
// right answer, the expected merged blocks.

interface Pair {
  ours: Op[];
  theirs: Op[];
  /** Expected merged blocks, given the holder. */
  expected?: (holder: Holder) => string[];
}

type Scenario = (rng: Rng, blocks: string[]) => Pair | null;

const SCENARIOS: Record<string, Scenario> = {
  /** Both edit different, non-adjacent blocks. */
  differentBlocks(rng, blocks) {
    const ed = editableIndices(blocks);
    if (ed.length < 2) return null;
    const i = pick(rng, ed);
    const far = ed.filter((j) => Math.abs(j - i) >= 2);
    if (!far.length) return null;
    const j = pick(rng, far);
    const ours = editBlock(rng, blocks, i, "o");
    const theirs = editBlock(rng, blocks, j, "t");
    if (!ours || !theirs) return null;
    return { ours: [ours], theirs: [theirs], expected: () => apply(blocks, [ours, theirs]) };
  },

  /** Both edit neighbouring blocks. */
  adjacentBlocks(rng, blocks) {
    const ed = editableIndices(blocks).filter((i) => editableIndices(blocks).includes(i + 1));
    if (!ed.length) return null;
    const i = pick(rng, ed);
    const ours = editBlock(rng, blocks, i, "o");
    const theirs = editBlock(rng, blocks, i + 1, "t");
    if (!ours || !theirs) return null;
    return { ours: [ours], theirs: [theirs], expected: () => apply(blocks, [ours, theirs]) };
  },

  /** One side types in a block, the other inserts a block right after it. */
  editAndInsertAfter(rng, blocks) {
    const ed = editableIndices(blocks);
    if (!ed.length) return null;
    const i = pick(rng, ed);
    const edit = editBlock(rng, blocks, i, "o");
    if (!edit) return null;
    const insert: Op = { at: i + 1, del: 0, insert: [newBlock(rng, "t")] };
    const swap = rng() < 0.5;
    const [ours, theirs] = swap ? [insert, edit] : [edit, insert];
    return { ours: [ours], theirs: [theirs], expected: () => apply(blocks, [edit, insert]) };
  },

  /** One side deletes a block, the other inserts and edits elsewhere. */
  deleteAndInsert(rng, blocks) {
    if (blocks.length < 4) return null;
    const d = int(rng, blocks.length);
    if (kindOf(blocks[d], d) === "frontmatter") return null;
    const ed = editableIndices(blocks).filter((j) => Math.abs(j - d) >= 2);
    if (!ed.length) return null;
    const j = pick(rng, ed);
    const del: Op = { at: d, del: 1, insert: [] };
    const edit = editBlock(rng, blocks, j, "t");
    if (!edit) return null;
    return { ours: [del], theirs: [edit], expected: () => apply(blocks, [del, edit]) };
  },

  /** Both type into the same paragraph or heading, at different spots. */
  sameBlockDifferentSpots(rng, blocks) {
    const cand = blocks.flatMap((b, i) =>
      ["paragraph", "heading"].includes(kindOf(b, i)) && !b.includes("\n") && boundaries(b).length >= 3 ? [i] : [],
    );
    if (!cand.length) return null;
    const i = pick(rng, cand);
    const bs = boundaries(blocks[i]);
    const a = int(rng, bs.length);
    let b = int(rng, bs.length - 1);
    if (b >= a) b++;
    const so = ` ${words(rng, "o")}`;
    const st = ` ${words(rng, "t")}`;
    const [pa, pb] = [bs[a], bs[b]];
    const ours: Op = { at: i, del: 1, insert: [insertAt(blocks[i], pa, so)] };
    const theirs: Op = { at: i, del: 1, insert: [insertAt(blocks[i], pb, st)] };
    const both = pa > pb ? insertAt(insertAt(blocks[i], pa, so), pb, st) : insertAt(insertAt(blocks[i], pb, st), pa, so);
    return { ours: [ours], theirs: [theirs], expected: () => apply(blocks, [{ at: i, del: 1, insert: [both] }]) };
  },

  /** Both rewrite the same words of a paragraph: the holder must win. */
  sameBlockOverlap(rng, blocks) {
    const cand = blocks.flatMap((b, i) =>
      kindOf(b, i) === "paragraph" && /\b[a-z]{4,}\b/.test(b) ? [i] : [],
    );
    if (!cand.length) return null;
    const i = pick(rng, cand);
    const found = [...blocks[i].matchAll(/\b[a-z]{4,}\b/g)];
    const m = pick(rng, found);
    const at = m.index ?? 0;
    const rewrite = (tag: string) =>
      blocks[i].slice(0, at) + words(rng, tag) + blocks[i].slice(at + m[0].length);
    const ours: Op = { at: i, del: 1, insert: [rewrite("o")] };
    const theirs: Op = { at: i, del: 1, insert: [rewrite("t")] };
    return {
      ours: [ours],
      theirs: [theirs],
      expected: (holder) => apply(blocks, [holder === "ours" ? ours : theirs]),
    };
  },

  /** Both edit different items of the same list. */
  listItems(rng, blocks) {
    const cand = blocks.flatMap((b, i) => (kindOf(b, i) === "list" && listItemLines(b).length >= 2 ? [i] : []));
    if (!cand.length) return null;
    const i = pick(rng, cand);
    const items = listItemLines(blocks[i]);
    const a = int(rng, items.length);
    let b = int(rng, items.length - 1);
    if (b >= a) b++;
    const ours = editListItem(rng, blocks[i], "o", items[a]);
    const theirs = editListItem(rng, blocks[i], "t", items[b]);
    // Both: ours with theirs' edited line.
    const lines = ours.split("\n");
    lines[items[b]] = theirs.split("\n")[items[b]];
    return {
      ours: [{ at: i, del: 1, insert: [ours] }],
      theirs: [{ at: i, del: 1, insert: [theirs] }],
      expected: () => apply(blocks, [{ at: i, del: 1, insert: [lines.join("\n")] }]),
    };
  },

  /** Both edit different cells of the same table. */
  tableCells(rng, blocks) {
    const cand = blocks.flatMap((b, i) => (kindOf(b, i) === "table" && tableCells(b).length >= 2 ? [i] : []));
    if (!cand.length) return null;
    const i = pick(rng, cand);
    const cells = tableCells(blocks[i]);
    const a = int(rng, cells.length);
    let b = int(rng, cells.length - 1);
    if (b >= a) b++;
    const ours = editTableCell(rng, blocks[i], "o", cells[a]);
    const theirs = editTableCell(rng, blocks[i], "t", cells[b]);
    const [ra, ca] = cells[a];
    const [rb, cb] = cells[b];
    const lines = blocks[i].split("\n");
    const cellOf = (s: string, r: number, c: number) => s.split("\n")[r].split("|")[c + 1];
    const set = (r: number, c: number, v: string) => {
      const parts = lines[r].split("|");
      parts[c + 1] = v;
      lines[r] = parts.join("|");
    };
    set(ra, ca, cellOf(ours, ra, ca));
    set(rb, cb, cellOf(theirs, rb, cb));
    return {
      ours: [{ at: i, del: 1, insert: [ours] }],
      theirs: [{ at: i, del: 1, insert: [theirs] }],
      expected: () => apply(blocks, [{ at: i, del: 1, insert: [lines.join("\n")] }]),
    };
  },

  /** Each side makes 1 to 3 random edits, inserts or deletes anywhere. */
  randomMix(rng, blocks) {
    const ops = (tag: string) => {
      let current = blocks;
      const n = 1 + int(rng, 3);
      for (let k = 0; k < n; k++) {
        const op = randomOp(rng, current, tag);
        if (op) current = apply(current, [op]);
      }
      return current;
    };
    const o = ops("o");
    const t = ops("t");
    return {
      ours: [{ at: 0, del: blocks.length, insert: o }],
      theirs: [{ at: 0, del: blocks.length, insert: t }],
    };
  },
};

// ---------------------------------------------------------------------------

const MARKER = /^(<{7}|>{7}|={7})(\s|$)/m;

describe.skipIf(!process.env.MERGE_CORPUS)("merge corpus", () => {
  // An opt-in measurement harness, not shipped code: one long tally loop.
  // fallow-ignore-next-line complexity
  it("merges generated concurrent edits on the repo's markdown", async () => {
    installWorkerDomShim();
    // Fresh codecs per base file, so one base's chunk cache never helps
    // another's timings. (A long-lived codec no longer slows down: the
    // parser applies its plugins once, see `usePluginsOnce`.)
    let codec = createMarkdownCodec();
    let merge = createMarkdownMerge(codec);
    // A second, independent codec + merge for the determinism check.
    let merge2 = createMarkdownMerge(createMarkdownCodec());
    const canon = (md: string) => codec.serialize(codec.parse(md));
    const assemble = (blocks: string[]) =>
      codec.serialize({ type: "doc", content: blocks.flatMap((b) => codec.parse(b).content ?? []) });

    const files = execFileSync("git", ["ls-files", "*.md"], { cwd: REPO, encoding: "utf8" })
      .split("\n")
      .filter((f) => f && !f.includes("node_modules/") && !f.split("/").includes(".notefig"))

    const nonRoundTrip: Array<{ file: string; firstDiff: string }> = [];
    let trailingNewlineOnly = 0;
    const notFixedPoint: string[] = [];
    type Tally = { pairs: number; failed: number; wrong: number; overwritten: number };
    const tally = (): Tally => ({ pairs: 0, failed: 0, wrong: 0, overwritten: 0 });
    const clean = { all: tally(), byScenario: {} as Record<string, Tally> };
    const dirty = { all: tally(), byScenario: {} as Record<string, Tally> };
    const failReasons: Record<string, number> = {};
    const failExamples: Array<{ file: string; scenario: string; reason: string; detail: string }> = [];
    const wrongExamples: Array<{ file: string; scenario: string; holder: Holder; expected: string; got: string }> = [];
    const times: number[] = [];
    const slow: Array<{ file: string; scenario: string; ms: number }> = [];
    let markers = 0;
    let nondeterministic = 0;
    // Byte preservation: segments of untouched blocks found verbatim.
    const untouched = { segments: 0, kept: 0, basesWithSpans: 0, basesWithoutSpans: [] as string[] };
    const lostExamples: Array<{ file: string; scenario: string; segment: string }> = [];
    const started = Date.now();

    const timedMerge = (file: string, scenario: string, input: Parameters<typeof merge>[0]) => {
      const t0 = Date.now();
      if (process.env.MERGE_CORPUS_DEBUG) process.stderr.write(`> ${file} ${scenario} ${input.base.length}\n`);
      const r: MergeResult = merge(input);
      const ms = Date.now() - t0;
      if (process.env.MERGE_CORPUS_DEBUG) process.stderr.write(`  merged ${ms}ms\n`);
      times.push(ms);
      if (ms > 500) slow.push({ file, scenario, ms });
      return r;
    };

    const recordFailure = (
      file: string,
      scenario: string,
      holder: Holder,
      roundTrips: boolean,
      reason: string,
    ) => {
      const key = `${roundTrips ? "clean" : "non-round-trip base"}: ${reason}`;
      failReasons[key] = (failReasons[key] ?? 0) + 1;
      if (failExamples.length < 12) failExamples.push({ file, scenario, reason, detail: holder });
    };

    const recordWrong = (
      where: { file: string; scenario: string; holder: Holder },
      expected: string,
      got: string,
    ) => {
      if (wrongExamples.length >= 40) return;
      let k = 0;
      while (k < expected.length && expected[k] === got[k]) k++;
      wrongExamples.push({
        ...where,
        expected: expected.slice(Math.max(0, k - 80), k + 80),
        got: got.slice(Math.max(0, k - 80), k + 80),
      });
    };

    /** Segments of blocks no op touched must be in the result verbatim. */
    const checkPreserved = (
      file: string,
      scenario: string,
      pair: { ours: Op[]; theirs: Op[] },
      spans: NonNullable<ReturnType<typeof sourceSpans>>,
      content: string,
    ) => {
      const ops = [...pair.ours, ...pair.theirs];
      const touched = (i: number) => ops.some((op) => i >= op.at - 1 && i <= op.at + op.del);
      spans.segments.forEach((segment, index) => {
        const indexes = spans.segmentOf.flatMap((seg, i) => (seg === index ? [i] : []));
        if (indexes.some(touched)) return;
        untouched.segments++;
        const body = segment.text.replace(/\s+$/, "");
        if (content.includes(body)) untouched.kept++;
        else if (lostExamples.length < 12) {
          lostExamples.push({ file, scenario, segment: body.slice(0, 160) });
        }
      });
    };

    /** Canonical, as any client sees it after one reload (two lists left
     *  adjacent, say, read back as one); the merge keeps base bytes for
     *  untouched blocks, so canonical forms are compared. */
    const matchesExpected = (
      blocks: string[],
      content: string,
      onWrong: (expected: string, got: string) => void,
    ) => {
      const expected = canon(assemble(blocks));
      const got = canon(content);
      if (expected !== got) onWrong(expected, got);
      return expected === got;
    };

    for (const [fileIndex, file] of files.entries()) {
      if (process.env.MERGE_CORPUS_FILTER && !file.includes(process.env.MERGE_CORPUS_FILTER)) continue;
      // Yield so vitest's worker RPC isn't starved by a long synchronous run.
      await new Promise((resolve) => setImmediate(resolve));
      codec = createMarkdownCodec();
      merge = createMarkdownMerge(codec);
      merge2 = createMarkdownMerge(createMarkdownCodec());
      const raw = readFileSync(path.join(REPO, file), "utf8");
      const roundTrips = canon(raw) === raw;
      if (!roundTrips) {
        const c = canon(raw);
        if (c + "\n" === raw) trailingNewlineOnly++;
        // Validation needs the codec's output to be a fixed point.
        if (canon(c) !== c) notFixedPoint.push(file);
        let k = 0;
        while (k < raw.length && raw[k] === c[k]) k++;
        nonRoundTrip.push({ file, firstDiff: JSON.stringify(raw.slice(Math.max(0, k - 30), k + 30)) + " → " + JSON.stringify(c.slice(Math.max(0, k - 30), k + 30)) });
      }
      const blocks = splitBlocks(codec, raw);
      const bucket = roundTrips ? clean : dirty;
      const spans = sourceSpans(raw, blocks, (chunk) => splitBlocks(codec, chunk));
      if (spans) untouched.basesWithSpans++;
      else untouched.basesWithoutSpans.push(file);

      // fallow-ignore-next-line complexity
      Object.entries(SCENARIOS).forEach(([name, scenario], si) => {
        const s = (bucket.byScenario[name] ??= tally());
        const count = (key: keyof Tally) => {
          bucket.all[key]++;
          s[key]++;
        };
        for (let p = 0; p < PAIRS; p++) {
          const rng = mulberry32(fileIndex * 1000 + si * 37 + p + 1);
          const pair = scenario(rng, blocks);
          if (!pair) continue;
          const holder: Holder = rng() < 0.5 ? "ours" : "theirs";
          const ours = assemble(apply(blocks, pair.ours));
          const theirs = assemble(apply(blocks, pair.theirs));
          const input = { base: raw, ours, theirs, holder };
          const r = timedMerge(file, name, input);
          count("pairs");
          if (JSON.stringify(merge2(input)) !== JSON.stringify(r)) nondeterministic++;
          if ("failed" in r) {
            count("failed");
            recordFailure(file, name, holder, roundTrips, r.failed);
            continue;
          }
          if (MARKER.test(r.content) && ![raw, ours, theirs].some((x) => MARKER.test(x))) markers++;
          if (r.overwritten.length) count("overwritten");
          if (spans) checkPreserved(file, name, pair, spans, r.content);
          const wrong = (expected: string, got: string) =>
            recordWrong({ file, scenario: name, holder }, expected, got);
          if (pair.expected && !matchesExpected(pair.expected(holder), r.content, wrong)) {
            count("wrong");
          }
        }
      });
    }

    const report = {
      files: files.length,
      seconds: (Date.now() - started) / 1000,
      nonRoundTripBases: nonRoundTrip.length,
      trailingNewlineOnly,
      notFixedPoint,
      clean,
      dirty,
      failReasons,
      markers,
      nondeterministic,
      failRateClean: clean.all.failed / Math.max(1, clean.all.pairs),
      untouched,
      lostExamples,
      mergeMs: (() => {
        const t = [...times].sort((a, b) => a - b);
        const q = (p: number) => t[Math.min(t.length - 1, Math.floor(p * t.length))];
        return { p50: q(0.5), p95: q(0.95), p99: q(0.99), max: t[t.length - 1] };
      })(),
      slow,
      nonRoundTrip,
      failExamples,
      wrongExamples,
    };
    if (process.env.MERGE_CORPUS_OUT) {
      writeFileSync(process.env.MERGE_CORPUS_OUT, JSON.stringify(report, null, 2));
    } else {
      console.log("MERGE_CORPUS_REPORT " + JSON.stringify(report, null, 2));
    }

    expect(markers).toBe(0);
    expect(nondeterministic).toBe(0);
  }, 3_600_000);
});
