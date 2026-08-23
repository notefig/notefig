/**
 * Pure helpers for link handling in the Tiptap editor: classifying hrefs,
 * resolving workspace-internal targets, and normalizing user input from the
 * link modal.
 */

import { isTextFile } from "@/utils/fs";
import { path as pathutil } from "@/utils/path";

/** URLs we open outside the app (OS browser / mail client). */
export function isExternalUrl(url: string): boolean {
  return /^(https?|mailto):/i.test(url);
}

/** Join a native base dir with a markdown ("/"-separated) href and resolve
 *  "." / ".." segments, clamped at the filesystem root. Returns native. */
export function resolvePath(baseDir: string, relative: string): string {
  const posixBase = pathutil.toPosixAbsolute(baseDir);
  const parts = `${posixBase}/${relative}`.split("/");
  // Root segments ".." can never pop: posix [""], drive ["C:"], UNC 4.
  const rootCount = posixBase.startsWith("//") ? 4 : 1;
  const kept = parts.slice(0, rootCount);
  const resolved: string[] = [];
  for (const segment of parts.slice(rootCount)) {
    if (!segment || segment === ".") continue;
    if (segment === "..") resolved.pop();
    else resolved.push(segment);
  }
  return pathutil.normalize([...kept, ...resolved].join("/") || "/");
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
  const candidates =
    href.startsWith("/") || pathutil.isAbsolute(href)
      ? [href]
      : [...new Set([resolvePath(fileDir, href), resolvePath(basePath, href)])];

  return candidates.filter((candidate) => {
    const rel = pathutil.relative(basePath, candidate);
    return rel !== undefined && rel !== "";
  });
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
