/**
 * Pure helpers for link handling in the Tiptap editor: classifying hrefs,
 * resolving workspace-internal targets, and normalizing user input from the
 * link modal.
 */

import { isTextFile } from "@/utils/fs";

/** URLs we open outside the app (OS browser / mail client). */
export function isExternalUrl(url: string): boolean {
  return /^(https?|mailto):/i.test(url);
}

/** Join and normalize, resolving "." and ".." segments (clamped at root). */
export function resolvePath(baseDir: string, relative: string): string {
  const resolved: string[] = [];
  for (const segment of `${baseDir}/${relative}`.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") resolved.pop();
    else resolved.push(segment);
  }
  return `/${resolved.join("/")}`;
}

/**
 * Absolute workspace paths an internal href may refer to, in priority order:
 * relative to the containing file (markdown convention) first, workspace
 * root as fallback — mirroring how image paths resolve. Every candidate is
 * clamped to the workspace so a hostile href ("../../../etc/passwd") never
 * resolves outside it.
 */
export function buildInternalCandidates(
  href: string,
  { fileDir, basePath }: { fileDir: string; basePath: string },
): string[] {
  const candidates = href.startsWith("/")
    ? [href]
    : [...new Set([resolvePath(fileDir, href), resolvePath(basePath, href)])];

  return candidates.filter((candidate) => candidate.startsWith(`${basePath}/`));
}

/**
 * Normalize link-modal input. Bare domains ("google.com") get https://
 * prepended; anything that already names a scheme, an in-workspace path
 * (/abs, ./rel, ../rel, #anchor), or a file the editor can open
 * ("notes.md") is kept as-is.
 */
export function normalizeLinkInput(value: string): string {
  const keepAsIs =
    /^(https?|mailto|data|asset):/i.test(value) ||
    value.startsWith("/") ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.startsWith("#") ||
    isTextFile(value);

  return keepAsIs ? value : `https://${value}`;
}
