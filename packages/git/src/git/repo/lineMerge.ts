/// <reference path="./diff3.d.ts" />
/**
 * git's default text merge: line-level diff3, with conflict markers where
 * both sides changed the same lines. The same algorithm isomorphic-git's
 * own merge uses (its `mergeFile` isn't exported).
 */
import diff3Merge from "diff3";

const MARKER = 7;

/**
 * Lines ending in LF, each keeping its terminator. Only LF splits: a lone
 * CR, U+2028 and U+2029 stay inside their line, so joining the lines back
 * gives exactly the input.
 */
function splitLines(text: string): string[] {
  const lines: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = text.indexOf("\n", start);
    const next = end < 0 ? text.length : end + 1;
    lines.push(text.slice(start, next));
    start = next;
  }
  return lines;
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
