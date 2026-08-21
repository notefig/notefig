// @-mention parsing for agent prompt composers (MET-80). Pure text math —
// no React, no collections — shared by the mention picker UI and the
// submit-time extraction that turns mentions into prompt context parts.
//
// Mentions are stateless: picking a file inserts a literal
// `@<relative/path>` into the draft, and the submitted text is re-scanned
// for tokens that resolve to real workspace files. Nothing to persist
// alongside drafts, and hand-typed or edited mentions behave identically to
// picked ones. Paths containing whitespace can't be referenced this way.

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

/**
 * Every candidate mention token in a finished prompt, in order, deduped.
 * Callers resolve tokens against the workspace; ones that aren't real files
 * are just text. For each token a variant with trailing punctuation
 * stripped is included too, so "see @notes.md." still resolves.
 */
export function extractMentionTokens(text: string): string[] {
  const tokens = new Set<string>();
  for (const match of text.matchAll(/(?:^|\s)@(\S+)/g)) {
    const token = match[1];
    tokens.add(token);
    const stripped = token.replace(/[.,;:!?)\]}'"`]+$/, "");
    if (stripped && stripped !== token) tokens.add(stripped);
  }
  return [...tokens];
}
