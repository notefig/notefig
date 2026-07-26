/**
 * PII scrubbing for outgoing telemetry. Applied to EVERY event via
 * posthog-js `before_send`, not just exceptions: our routes embed
 * URL-encoded workspace paths, and error messages routinely quote
 * absolute paths, file names, and document content, so any string
 * property is a potential leak.
 *
 * Layers, in order:
 *   1. Home directories (raw + URL-encoded) → `~`
 *   2. Remaining absolute / UNC paths → `<path>`
 *   3. User-content file names (by extension) → `<file>`
 *   4. Email addresses → `<email>`
 *   5. Exception messages only: quoted substrings → `<redacted>`
 *      (error messages quote user data — "Failed to parse 'My Notes'")
 */

const HOME_DIR_PATTERNS: RegExp[] = [
  /\/Users\/[^/\s:"')]+/g,
  /\/home\/[^/\s:"')]+/g,
  /[A-Za-z]:\\Users\\[^\\\s:"')]+/g,
];

const ENCODED_HOME_PATTERNS: RegExp[] = [
  /%2F[Uu]sers%2F[^%\s&"']+/g,
  /%2Fhome%2F[^%\s&"']+/g,
];

// Two or more path segments (unix or windows drive). Catches non-home
// absolute paths (e.g. /Volumes/..., /tmp/..., D:\work\...) and tilde
// paths (~/Documents/...) left after home-dir replacement.
const ABSOLUTE_PATH_PATTERN =
  /(?:~?(?:\/[^/\s:"')]+){2,})|(?:[A-Za-z]:(?:\\[^\\\s:"')]+){2,})/g;

// Windows UNC shares: \\server\share\dir\file
const UNC_PATH_PATTERN = /\\\\[^\\\s:"')]+(?:\\[^\\\s:"')]+)+/g;

// File names with user-content extensions, including multi-word names
// ("Meeting Notes.md"). Deliberately excludes code/bundle extensions
// (.js/.ts/.css) so app stack frames stay debuggable — those are our
// files, not the user's.
const USER_FILE_EXTENSIONS =
  "md|markdown|mdx|txt|rtf|pdf|docx?|odt|xlsx?|ods|pptx?|odp|csv|tsv|json|ya?ml|toml|xml|png|jpe?g|gif|svg|webp|heic|tiff?|bmp|mp3|wav|m4a|mp4|mov|avi|mkv|zip|tar|gz|epub";
const FILENAME_CHAR = String.raw`[\p{L}\p{N}_%()[\]{}~$@#&+',!-]`;
const USER_FILENAME_PATTERN = new RegExp(
  String.raw`${FILENAME_CHAR}+(?:[ .]${FILENAME_CHAR}+)*\.(?:${USER_FILE_EXTENSIONS})\b`,
  "giu",
);

const EMAIL_PATTERN = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;

// Quoted substrings — 'x', "x", `x`, “x” — replaced wholesale in
// exception messages, where quotes almost always wrap user data.
const QUOTED_CONTENT_PATTERN = /(["'`“])(?:(?!\1|”).)*(?:\1|”)/g;

// Properties PostHog attaches automatically that can carry URLs/paths or
// identifying context. Removed outright.
const STRIPPED_PROPERTIES = [
  "$current_url",
  "$pathname",
  "$host",
  "$initial_referrer",
  "$initial_referring_domain",
  "$referrer",
  "$referring_domain",
  "$ip",
  "$raw_user_agent",
];

// Belt-and-braces cap: no single string property should be anywhere near
// this long; oversized values are most likely serialized user data.
const MAX_STRING_LENGTH = 2000;

export function scrubString(input: string): string {
  let result = input;
  for (const pattern of HOME_DIR_PATTERNS) {
    result = result.replace(pattern, "~");
  }
  for (const pattern of ENCODED_HOME_PATTERNS) {
    result = result.replace(pattern, "~");
  }
  result = result.replace(UNC_PATH_PATTERN, "<path>");
  result = result.replace(ABSOLUTE_PATH_PATTERN, "<path>");
  result = result.replace(USER_FILENAME_PATTERN, "<file>");
  result = result.replace(EMAIL_PATTERN, "<email>");
  if (result.length > MAX_STRING_LENGTH) {
    result = result.slice(0, MAX_STRING_LENGTH) + "…<truncated>";
  }
  return result;
}

/** Harder variant for exception messages: also drops quoted substrings. */
export function scrubExceptionMessage(input: string): string {
  return scrubString(input.replace(QUOTED_CONTENT_PATTERN, "<redacted>"));
}

function scrubValue(value: unknown): unknown {
  if (typeof value === "string") return scrubString(value);
  if (Array.isArray(value)) return value.map(scrubValue);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = scrubValue(v);
    }
    return out;
  }
  return value;
}

function scrubExceptionList(list: unknown): void {
  if (!Array.isArray(list)) return;
  for (const item of list) {
    if (item && typeof item === "object") {
      const entry = item as Record<string, unknown>;
      if (typeof entry.value === "string") {
        entry.value = scrubExceptionMessage(entry.value);
      }
    }
  }
}

/**
 * `before_send` hook. Shape kept loose (posthog-js CaptureResult) so this
 * module has no posthog import and stays trivially unit-testable.
 */
export function scrubEvent<
  T extends { properties?: Record<string, unknown> | undefined } | null,
>(event: T): T {
  if (!event) return event;
  if (event.properties) {
    for (const key of STRIPPED_PROPERTIES) {
      delete event.properties[key];
    }
    event.properties = scrubValue(event.properties) as Record<string, unknown>;
    scrubExceptionList(event.properties["$exception_list"]);
    if (typeof event.properties["$exception_message"] === "string") {
      event.properties["$exception_message"] = scrubExceptionMessage(
        event.properties["$exception_message"],
      );
    }
  }
  return event;
}
