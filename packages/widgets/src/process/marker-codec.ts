/**
 * The on-disk form of a process block, the prompt marker's sibling
 * (../prompt/marker-codec.ts):
 *
 *     <!-- notefig:process id="blob_1a2b" command="npm run dev" -->
 *
 * A comment for the same reason the prompt's is one: the file is the
 * user's, and every other markdown tool renders it as nothing. Unlike the
 * prompt it carries the command itself — there is no session row to hold
 * it, and the command is the block's definition, not live state, so a
 * rewrite of the file can't leave it stale. The process and its output are
 * never written: they belong to this run of the app.
 *
 * The id's charset is closed, as the prompt's is. The command's is not, so
 * it is escaped: `&`, `"`, `>` and newlines, which is what keeps it from
 * ending the attribute, the comment (`-->`, `--!>`) or markdown's html
 * block (a line break).
 */

const SENTINEL = "notefig:process";
const ID = String.raw`[A-Za-z0-9_-]+`;
const BODY = String.raw`${SENTINEL}\s+id="(${ID})"\s+command="([^"]*)"`;

const MARKER_PATTERN = new RegExp(String.raw`^<!--\s*${BODY}\s*-->$`);
const MARKER_DATA_PATTERN = new RegExp(String.raw`^\s*${BODY}\s*$`);
const MARKER_GLOBAL_PATTERN = new RegExp(String.raw`<!--\s*${BODY}\s*-->`, "g");

export interface ProcessMarker {
  /** The block instance (`blobId` attr) whose process and output these are. */
  blobId: string;
  /** What the block runs, through the platform's shell. */
  command: string;
}

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  '"': "&quot;",
  ">": "&gt;",
  "\n": "&#10;",
};
const UNESCAPES = Object.fromEntries(
  Object.entries(ESCAPES).map(([char, entity]) => [entity, char]),
);

/** The comment for a block, or null when it has no id or nothing to run. */
export function serializeProcessMarker(marker: {
  blobId?: string | null;
  command?: string | null;
}): string | null {
  const { blobId, command } = marker;
  if (!blobId || !command) return null;
  if (!new RegExp(String.raw`^${ID}$`).test(blobId)) return null;
  const escaped = command.replace(/[&">\n]/g, (char) => ESCAPES[char]);
  return `<!-- ${SENTINEL} id="${blobId}" command="${escaped}" -->`;
}

function fromMatch(match: RegExpExecArray | null): ProcessMarker | null {
  if (!match) return null;
  const command = match[2].replace(/&(amp|quot|gt|#10);/g, (e) => UNESCAPES[e]);
  return command ? { blobId: match[1], command } : null;
}

/** Parse a whole comment, e.g. a line read straight out of the file. */
export function parseProcessMarker(text: string): ProcessMarker | null {
  return fromMatch(MARKER_PATTERN.exec(text.trim()));
}

/** Parse a DOM comment node's `data` (the sentinel without its delimiters). */
export function parseProcessMarkerData(data: string): ProcessMarker | null {
  return fromMatch(MARKER_DATA_PATTERN.exec(data));
}

/** The file with our markers taken out. */
export function stripProcessMarkers(markdown: string): string {
  return markdown.replace(MARKER_GLOBAL_PATTERN, "");
}
