/**
 * The on-disk form of a prompt widget (MET-163).
 *
 * A widget that has been sent to an agent is no longer pure UI: losing it on
 * the next agent write (adoption re-parses the file, and markdown carried no
 * trace of the widget) took the running/answered round with it. It now
 * persists as a single HTML comment:
 *
 *     <!-- notefig:prompt id="blob_1a2b" task="task_9f8e" -->
 *
 * A comment because the file belongs to the user, not to us: every other
 * markdown tool renders it as nothing at all, which is the "no maintenance
 * burden" half of the ticket. It carries only two ids, not the conversation:
 * `task` addresses the agent session that owns the round (the task row holds
 * the ACP session id and is what revival resumes), and `id` is the widget's
 * instance identity, which is what makes an adopted re-parse land back on
 * the same live state instead of a fresh empty widget.
 *
 * Ids are minted by us (`blob_<base36>`, `task_<base36>`), so the charset is
 * closed — the pattern below is also what keeps a hand-edited value from
 * closing the comment early and injecting markup.
 */

/** Distinguishes our comments from every other comment in the file. */
const SENTINEL = "notefig:prompt";

/** Minted-id charset. Anything else is not one of our markers. */
const ID = String.raw`[A-Za-z0-9_-]+`;

/** The comment as it appears in the file, capturing both ids. */
const MARKER_PATTERN = new RegExp(
  String.raw`^<!--\s*${SENTINEL}\s+id="(${ID})"\s+task="(${ID})"\s*-->$`,
);

/** The comment's inner text (what the DOM hands us as `Comment.data`). */
const MARKER_DATA_PATTERN = new RegExp(
  String.raw`^\s*${SENTINEL}\s+id="(${ID})"\s+task="(${ID})"\s*$`,
);

export interface PromptMarker {
  /** The widget instance (`blobId` attr) whose state this round belongs to. */
  blobId: string;
  /** The agent task owning the session this widget is bound to. */
  taskId: string;
}

function isMintedId(value: string): boolean {
  return new RegExp(String.raw`^${ID}$`).test(value);
}

/**
 * The comment for a bound widget, or null when there is nothing worth
 * persisting: an unbound widget (the empty-document keeper, a freshly
 * summoned one) is still pure UI and must leave the file untouched, exactly
 * as before this change.
 */
export function serializePromptMarker(marker: {
  blobId?: string | null;
  taskId?: string | null;
}): string | null {
  const { blobId, taskId } = marker;
  if (!blobId || !taskId) return null;
  if (!isMintedId(blobId) || !isMintedId(taskId)) return null;
  return `<!-- ${SENTINEL} id="${blobId}" task="${taskId}" -->`;
}

/** Parse a whole comment, e.g. a line read straight out of the file. */
export function parsePromptMarker(text: string): PromptMarker | null {
  const match = MARKER_PATTERN.exec(text.trim());
  return match ? { blobId: match[1], taskId: match[2] } : null;
}

/** Parse a DOM comment node's `data` (the sentinel without its delimiters). */
export function parsePromptMarkerData(data: string): PromptMarker | null {
  const match = MARKER_DATA_PATTERN.exec(data);
  return match ? { blobId: match[1], taskId: match[2] } : null;
}

const MARKER_GLOBAL_PATTERN = new RegExp(
  String.raw`<!--\s*${SENTINEL}\s+id="${ID}"\s+task="${ID}"\s*-->`,
  "g",
);

/**
 * The file with our markers taken out — for callers asking "did the user
 * actually put anything here?". A document holding nothing but a widget is
 * still an empty document to them, and must stay eligible for the things
 * emptiness gates (the untitled-scratchpad sweep).
 */
export function stripPromptMarkers(markdown: string): string {
  return markdown.replace(MARKER_GLOBAL_PATTERN, "");
}
