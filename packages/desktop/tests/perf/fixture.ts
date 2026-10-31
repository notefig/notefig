/**
 * The perf suite's workspace, generated rather than checked in: 20,000
 * notes in a three-level tree, a short `README.md` to open, and `large.md`,
 * an 8,000-line document with tables and six prompt widgets.
 *
 * Seeded, so every run (and both sides of a base/head comparison) measures
 * byte-identical files. Bump FIXTURE_VERSION when the shape changes; the
 * numbers before and after are not comparable.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export const FIXTURE_VERSION = 1;

export const AREAS = 20;
export const TOPICS = 20;
export const NOTES = 50;
export const LARGE_LINES = 8000;
export const WIDGETS = 6;

/** Text in README.md the open scenario waits for. */
export const README_SENTINEL = "Perf fixture readme";

/** mulberry32: small, fast, and the same everywhere. */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = (
  "the of and to in is that for it as with was on be at by this had not are " +
  "but from or have an they which one you were all we her she there would " +
  "their will when who him been has more if no out so said what up its about " +
  "into than them can only other new some could time these two may then do " +
  "first any my now such like our over man me even most made after also did " +
  "many before must through back years where much your way well down should " +
  "because each just those people how too little state good very make world " +
  "still own see men work long get here between both life being under never"
).split(" ");

function sentence(rand: () => number, min = 6, max = 18): string {
  const n = min + Math.floor(rand() * (max - min));
  const words = Array.from(
    { length: n },
    () => WORDS[Math.floor(rand() * WORDS.length)],
  );
  words[0] = words[0][0].toUpperCase() + words[0].slice(1);
  return `${words.join(" ")}.`;
}

function paragraph(rand: () => number): string {
  return Array.from({ length: 2 + Math.floor(rand() * 4) }, () =>
    sentence(rand),
  ).join(" ");
}

function note(rand: () => number, title: string): string {
  const lines = [`# ${title}`, ""];
  const blocks = 3 + Math.floor(rand() * 6);
  for (let i = 0; i < blocks; i++) {
    if (rand() < 0.25) {
      for (let j = 0; j < 3; j++) lines.push(`- ${sentence(rand, 3, 8)}`);
    } else {
      lines.push(paragraph(rand));
    }
    lines.push("");
  }
  return lines.join("\n");
}

function table(rand: () => number, rows: number): string[] {
  const cols = 5;
  const header = Array.from({ length: cols }, (_, c) => `Column ${c + 1}`);
  const out = [`| ${header.join(" | ")} |`, `|${" --- |".repeat(cols)}`];
  for (let r = 0; r < rows; r++) {
    const cells = Array.from({ length: cols }, () => sentence(rand, 1, 4));
    out.push(`| ${cells.join(" | ")} |`);
  }
  return out;
}

/** A persisted (bound) widget, as the file carries it. */
export function widgetMarker(i: number): string {
  return `<!-- notefig:prompt id="blob_perf${i}" task="task_perf${i}" -->`;
}

/**
 * 8,000 lines of the blocks a long working document has: headings,
 * paragraphs, lists, code, a table every few sections, and a widget at
 * each sixth of the way down.
 */
export function largeDocument(): string {
  const rand = rng(8000);
  const lines: string[] = ["# Large document", ""];
  const widgetEvery = Math.floor(LARGE_LINES / WIDGETS);
  let widgets = 0;
  let section = 0;
  while (lines.length < LARGE_LINES) {
    section++;
    lines.push(`## Section ${section}`, "");
    if (widgets < WIDGETS && lines.length >= widgets * widgetEvery + 40) {
      lines.push(widgetMarker(widgets), "");
      widgets++;
    }
    lines.push(paragraph(rand), "", paragraph(rand), "");
    if (section % 6 === 0) lines.push(...table(rand, 12), "");
    if (section % 4 === 0) {
      for (let j = 0; j < 5; j++) lines.push(`- ${sentence(rand, 3, 10)}`);
      lines.push("");
    }
    if (section % 7 === 0) {
      lines.push(
        "```ts",
        "const value = compute(input);",
        "return value;",
        "```",
        "",
      );
    }
  }
  return lines.slice(0, LARGE_LINES).join("\n") + "\n";
}

async function write(root: string): Promise<void> {
  const rand = rng(20000);
  await fs.writeFile(path.join(root, "README.md"), note(rand, README_SENTINEL));
  await fs.writeFile(path.join(root, "large.md"), largeDocument());
  for (let a = 0; a < AREAS; a++) {
    for (let t = 0; t < TOPICS; t++) {
      const dir = path.join(root, `area-${a}`, `topic-${t}`);
      await fs.mkdir(dir, { recursive: true });
      await Promise.all(
        Array.from({ length: NOTES }, (_, n) =>
          fs.writeFile(
            path.join(dir, `note-${n}.md`),
            note(rand, `Note ${a}.${t}.${n}`),
          ),
        ),
      );
    }
  }
}

/**
 * The fixture workspace, generated on first use under the OS temp dir and
 * reused after. The stamp beside it (not in it, where the tree would list
 * it) keeps a run that died mid-write from being reused.
 */
export async function perfWorkspace(): Promise<string> {
  const root = path.join(os.tmpdir(), `notefig-perf-v${FIXTURE_VERSION}`);
  const stamp = `${root}.complete`;
  try {
    await fs.access(stamp);
    return root;
  } catch {
    await fs.rm(root, { recursive: true, force: true });
  }
  await fs.mkdir(root, { recursive: true });
  await write(root);
  await fs.writeFile(stamp, "");
  return root;
}

/**
 * Put `large.md` back as generated. The editing scenarios save as they
 * type; each run starts from the same bytes.
 */
export async function resetLargeDocument(root: string): Promise<void> {
  await fs.writeFile(path.join(root, "large.md"), largeDocument());
}
