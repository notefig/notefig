/**
 * The on-disk form of a process block, the prompt marker's sibling
 * (../prompt/marker-codec.ts):
 *
 *     <!-- notefig:process id="blob_1a2b" -->
 *
 * A comment for the same reason the prompt's is one: the file is the
 * user's, and every other markdown tool renders it as nothing. It carries
 * the id alone. The command is the app's, registered under that id when an
 * agent starts the block, so a file can't bring a command of its own: an id
 * the app never minted is a block the app drops. The process and its output
 * are never written either: they belong to this run of the app.
 *
 * The id's charset is closed, as the prompt's is, which is what keeps a
 * hand-edited value from ending the comment.
 */

const SENTINEL = "notefig:process";
const ID = String.raw`[A-Za-z0-9_-]+`;
const BODY = String.raw`${SENTINEL}\s+id="(${ID})"`;

const MARKER_PATTERN = new RegExp(String.raw`^<!--\s*${BODY}\s*-->$`);
const MARKER_DATA_PATTERN = new RegExp(String.raw`^\s*${BODY}\s*$`);
const MARKER_GLOBAL_PATTERN = new RegExp(String.raw`<!--\s*${BODY}\s*-->`, "g");

export interface ProcessMarker {
  /** The block instance (`blobId` attr): its registration, process and output. */
  blobId: string;
}

/** The comment for a block, or null when it has no id. */
export function serializeProcessMarker(marker: {
  blobId?: string | null;
}): string | null {
  const { blobId } = marker;
  if (!blobId || !new RegExp(String.raw`^${ID}$`).test(blobId)) return null;
  return `<!-- ${SENTINEL} id="${blobId}" -->`;
}

function fromMatch(match: RegExpExecArray | null): ProcessMarker | null {
  return match ? { blobId: match[1] } : null;
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
