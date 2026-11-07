/// <reference path="./diff3.d.ts" />
/**
 * git's default text merge: line-level diff3, with conflict markers where
 * both sides changed the same lines. The same algorithm isomorphic-git's
 * own merge uses (its `mergeFile` isn't exported).
 */
import diff3Merge from "diff3";

const LINES = /^.*(\r?\n|$)/gm;
const MARKER = 7;

function splitLines(text: string): string[] {
  return text.match(LINES) ?? [];
}

function withNewline(lines: string[]): string {
  const text = lines.join("");
  return text === "" || text.endsWith("\n") ? text : `${text}\n`;
}

export function lineMerge(
  base: string,
  ours: string,
  theirs: string,
  labels: { ours: string; theirs: string } = { ours: "ours", theirs: "theirs" },
): { content: string; conflicted: boolean } {
  let content = "";
  let conflicted = false;
  for (const region of diff3Merge(
    splitLines(ours),
    splitLines(base),
    splitLines(theirs),
  )) {
    if ("ok" in region) {
      content += region.ok.join("");
      continue;
    }
    conflicted = true;
    content += `${"<".repeat(MARKER)} ${labels.ours}\n`;
    content += withNewline(region.conflict.a);
    content += `${"=".repeat(MARKER)}\n`;
    content += withNewline(region.conflict.b);
    content += `${">".repeat(MARKER)} ${labels.theirs}\n`;
  }
  return { content, conflicted };
}
