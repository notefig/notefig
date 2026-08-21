// @-mention parsing for agent prompt composers (MET-80). Pure text math —
// no React, no collections — shared by the mention picker UI and the
// submit-time extraction that turns mentions into prompt context parts.
//
// Mentions are stateless: picking a file inserts a literal
// `@<relative/path>` into the draft, and the submitted text is re-scanned
// for tokens that resolve to real workspace files. Nothing to persist
// alongside drafts, and hand-typed or edited mentions behave identically to
// picked ones. Paths containing spaces resolve too: extraction tries
// multi-word candidates against the workspace, longest match first.

export interface ActiveMention {
  /** Index of the "@" in the text. */
  start: number;
  /** Characters typed after the "@", up to the caret. */
  query: string;
}

/**
 * The mention being typed at the caret, if any: an "@" at the start of the
 * text or after whitespace, with no whitespace between it and the caret.
 * (`a@b` is not a mention — emails and mid-word "@" stay inert.)
 */
export function getActiveMention(
  text: string,
  caret: number,
): ActiveMention | null {
  const before = text.slice(0, caret);
  const start = before.lastIndexOf("@");
  if (start === -1) return null;
  if (start > 0 && !/\s/.test(text[start - 1])) return null;
  const query = before.slice(start + 1);
  if (/\s/.test(query)) return null;
  return { start, query };
}

/** Replace the active mention with `@<relativePath>` plus a trailing space. */
export function applyMention(
  text: string,
  mention: ActiveMention,
  caret: number,
  relativePath: string,
): { text: string; caret: number } {
  const inserted = `@${relativePath} `;
  return {
    text: text.slice(0, mention.start) + inserted + text.slice(caret),
    caret: mention.start + inserted.length,
  };
}

// A mention can't run past its line, and candidate probing is bounded so a
// long prose line doesn't test dozens of prefixes per "@".
const MAX_MENTION_WORDS = 8;

const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"`]+$/;

/**
 * Every mention in a finished prompt that `isPath` accepts, in order,
 * deduped. For each "@" (at start of text or after whitespace) the
 * candidates are the line's word-boundary prefixes after the "@", tested
 * longest first — so `@my file.md is great` resolves "my file.md" when that
 * file exists (paths with spaces survive), and falls back to "my" only if
 * that is itself a file. A trailing-punctuation-stripped variant of each
 * candidate is tried too, so "see @notes.md." still resolves. Tokens
 * nothing accepts are just text.
 */
/** The line's word-boundary prefixes after an "@" — the strings a mention
 *  could be, shortest first. */
function mentionCandidates(rest: string): string[] {
  const candidates: string[] = [];
  const word = /\S+/g;
  let match: RegExpExecArray | null;
  while ((match = word.exec(rest)) && candidates.length < MAX_MENTION_WORDS) {
    candidates.push(rest.slice(0, match.index + match[0].length));
  }
  return candidates;
}

/** The candidate itself, or its punctuation-stripped variant, if accepted. */
function resolveCandidate(
  candidate: string,
  isPath: (candidate: string) => boolean,
): string | null {
  if (isPath(candidate)) return candidate;
  const stripped = candidate.replace(TRAILING_PUNCTUATION, "");
  if (stripped && stripped !== candidate && isPath(stripped)) return stripped;
  return null;
}

/** Longest accepted candidate, with the length the match consumed. */
function longestMention(
  candidates: string[],
  isPath: (candidate: string) => boolean,
): { hit: string; consumed: number } | null {
  for (let i = candidates.length - 1; i >= 0; i--) {
    const hit = resolveCandidate(candidates[i], isPath);
    if (hit) return { hit, consumed: candidates[i].length };
  }
  return null;
}

export function extractMentionPaths(
  text: string,
  isPath: (candidate: string) => boolean,
): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const mentionStart = /(?:^|\s)@/g;
  let match: RegExpExecArray | null;
  while ((match = mentionStart.exec(text))) {
    const start = match.index + match[0].length;
    const newline = text.indexOf("\n", start);
    const rest = text.slice(start, newline === -1 ? text.length : newline);
    if (!rest || /^\s/.test(rest)) continue;

    const mention = longestMention(mentionCandidates(rest), isPath);
    if (!mention) continue;
    if (!seen.has(mention.hit)) found.push(mention.hit);
    seen.add(mention.hit);
    // Scan resumes after the matched mention, not after the "@".
    mentionStart.lastIndex = start + mention.consumed;
  }
  return found;
}
