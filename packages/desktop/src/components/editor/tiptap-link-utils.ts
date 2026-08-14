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

/**
 * Reverses encodeURIComponent, but tolerates segments that merely contain a
 * literal "%" (e.g. "100%.md") rather than throwing on the malformed escape.
 */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Percent-decodes an internal href for human display (e.g. the link bubble
 * menu) — the stored/saved form must stay encoded (relativeHrefFromDir), but
 * nothing about reading it back needs to. Never call this on an external
 * URL: a real "?q=a%20b" query string is supposed to look encoded.
 */
export function decodeHrefForDisplay(href: string): string {
  try {
    return decodeURIComponent(href);
  } catch {
    return href;
  }
}

/**
 * Join and normalize, resolving "." and ".." segments (clamped at root).
 * Segments are percent-decoded first so hrefs built by relativeHrefFromDir
 * (which percent-encodes path segments) resolve back to the real path.
 */
export function resolvePath(baseDir: string, relative: string): string {
  const resolved: string[] = [];
  for (const raw of `${baseDir}/${relative}`.split("/")) {
    const segment = decodeSegment(raw);
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
 * Relative href from a directory to an absolute workspace path — the
 * portable, hand-authored-looking form buildInternalCandidates resolves
 * first (fileDir-relative), inverse of resolvePath.
 *
 * Target segments are percent-encoded: prosemirror-markdown's link
 * serializer only escapes "(", ")" and '"' in the href, so a raw space (or
 * "<"/">") would produce a destination CommonMark can't parse unwrapped —
 * and a raw space would also break extractHrefFromMarkdownLink's own
 * whitespace-delimited href extraction (graph-data.ts). resolvePath decodes
 * segments back on the way in.
 */
export function relativeHrefFromDir(fromDir: string, toPath: string): string {
  const fromSegments = fromDir.split("/").filter(Boolean);
  const toSegments = toPath.split("/").filter(Boolean);

  let commonLength = 0;
  while (
    commonLength < fromSegments.length &&
    commonLength < toSegments.length &&
    fromSegments[commonLength] === toSegments[commonLength]
  ) {
    commonLength++;
  }

  const upSegments = fromSegments.slice(commonLength).map(() => "..");
  const downSegments = toSegments.slice(commonLength).map(encodeURIComponent);

  return [...upSegments, ...downSegments].join("/");
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
