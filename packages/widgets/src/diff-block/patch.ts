/**
 * A diff block's change, as `@pierre/diffs` holds one. No DOM: the editor
 * plugin asks whether a block draws before it draws anything.
 */
import { processFile, type FileDiffMetadata, type SupportedLanguages } from "@pierre/diffs";
import { createTwoFilesPatch } from "diff";
import { bundledLanguages } from "shiki";

/** The block's language, where Shiki knows it (Pierre would load another,
 *  and reject); else Pierre infers one from the file's name. */
function knownLanguage(language: string | null): SupportedLanguages | undefined {
  const known = language && language !== "text" && Object.prototype.hasOwnProperty.call(bundledLanguages, language);
  return known ? (language as SupportedLanguages) : undefined;
}

/** A block's unified diff as Pierre reads it, or null when it has no hunks. */
export function parseDiffBlock(language: string | null, text: string): FileDiffMetadata | null {
  const parsed = processFile(text);
  if (!parsed?.hunks.length) return null;
  const lang = knownLanguage(language);
  return lang ? { ...parsed, lang } : parsed;
}

/** How many lines the change adds and removes. */
export function diffStats(diff: FileDiffMetadata): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const hunk of diff.hunks) {
    added += hunk.additionLines;
    removed += hunk.deletionLines;
  }
  return { added, removed };
}

const withNewline = (text: string) => (text && !text.endsWith("\n") ? `${text}\n` : text);

/**
 * A block's body for a change given as its two texts — what an agent's edit
 * reports: `before` null for a new file, and `line` where the texts start
 * in it, when they are an excerpt.
 */
export function patchOf(path: string, before: string | null, after: string, line = 1): string {
  const patch = createTwoFilesPatch(
    before === null ? "/dev/null" : path,
    path,
    withNewline(before ?? ""),
    withNewline(after),
  );
  const shift = line - 1;
  return patch
    .slice(patch.indexOf("--- "))
    .replace(/^@@ -(\d+)(,\d+)? \+(\d+)(,\d+)? @@/gm, (_, from: string, fromCount = "", to: string, toCount = "") => {
      const at = (start: string) => (Number(start) === 0 ? 0 : Number(start) + shift);
      return `@@ -${at(from)}${fromCount} +${at(to)}${toCount} @@`;
    })
    .trimEnd();
}
