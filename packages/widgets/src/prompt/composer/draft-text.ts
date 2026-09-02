/**
 * The mention text contract, and the conversions between it and document
 * content — pure, no React, no editor instance.
 *
 * Shared by the two surfaces that compose prompts: the widget, whose draft
 * IS document content (`aiPrompt > promptDraft`), and the chat tab's
 * standalone composer, which has no host document. Both agree that a
 * mention is nothing but the literal `@<relativePath>` text, so a draft
 * moved between them survives as a plain string.
 */
import type { JSONContent } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { PROMPT_DRAFT_NODE_NAME } from "../node";

// ─── The mention text contract ──────────────────────────────────────────
// Mentions are stateless text: picking a file inserts a literal
// `@<relative/path>` (as an atomic chip that serializes to the same text),
// and submit paths re-scan the final string for tokens that resolve to real
// workspace files. Nothing persists alongside drafts, and hand-typed or
// edited mentions behave identically to picked ones. Paths containing
// spaces resolve too: extraction probes multi-word candidates, longest
// first — gated to candidates whose last word has an extension dot or that
// end the line, so following prose can never extend a mention into an
// unintended longer filename.

// A mention can't run past its line, and candidate probing is bounded so a
// long prose line doesn't test dozens of prefixes per "@". Paths with more
// space-separated words than this don't resolve — at 16, far past any real
// filename.
const MAX_MENTION_WORDS = 16;

const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"`]+$/;

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

/** Multi-word candidates must look like a filename (extension dot in the
 *  last word) or consume the whole line — otherwise prose after a picked
 *  mention could combine into some other real file's name. */
function isPlausibleMention(candidate: string, rest: string): boolean {
  if (!/\s/.test(candidate)) return true;
  if (candidate.length === rest.length) return true;
  const lastWord = candidate.slice(candidate.search(/\S+$/));
  return lastWord.includes(".");
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
  rest: string,
  isPath: (candidate: string) => boolean,
): { hit: string; consumed: number } | null {
  const candidates = mentionCandidates(rest);
  for (let i = candidates.length - 1; i >= 0; i--) {
    if (!isPlausibleMention(candidates[i], rest)) continue;
    const hit = resolveCandidate(candidates[i], isPath);
    if (hit) return { hit, consumed: candidates[i].length };
  }
  return null;
}

export type MentionSegment =
  { type: "text"; value: string } | { type: "mention"; value: string };

/**
 * Split a prompt into plain-text runs and resolved mentions, in order. For
 * each "@" (at start of text or after whitespace) the candidates are the
 * line's word-boundary prefixes, tested longest first, with a
 * trailing-punctuation-stripped variant of each ("see @notes.md." still
 * resolves). Tokens nothing accepts are just text. Used to rebuild chips
 * from a persisted plain-string draft, and via extractMentionPaths at
 * submit time.
 */
export function segmentMentions(
  text: string,
  isPath: (candidate: string) => boolean,
): MentionSegment[] {
  const segments: MentionSegment[] = [];
  let plainFrom = 0;
  const pushText = (to: number) => {
    if (to > plainFrom) {
      segments.push({ type: "text", value: text.slice(plainFrom, to) });
    }
  };

  const mentionStart = /(?:^|\s)@/g;
  let match: RegExpExecArray | null;
  while ((match = mentionStart.exec(text))) {
    const start = match.index + match[0].length;
    const newline = text.indexOf("\n", start);
    const rest = text.slice(start, newline === -1 ? text.length : newline);
    if (!rest || /^\s/.test(rest)) continue;

    const mention = longestMention(rest, isPath);
    if (!mention) continue;
    pushText(start - 1);
    segments.push({ type: "mention", value: mention.hit });
    // Trailing punctuation the resolution stripped stays in the next text
    // segment; the scan resumes after the matched mention, not the "@".
    plainFrom = start + mention.hit.length;
    mentionStart.lastIndex = start + mention.consumed;
  }
  pushText(text.length);
  return segments;
}

/** Every distinct resolved mention in a finished prompt, in order. */
export function extractMentionPaths(
  text: string,
  isPath: (candidate: string) => boolean,
): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const segment of segmentMentions(text, isPath)) {
    if (segment.type !== "mention" || seen.has(segment.value)) continue;
    seen.add(segment.value);
    found.push(segment.value);
  }
  return found;
}

// ─── draft string ⇄ document content ────────────────────────

/** The inline content of a draft: text runs, and a chip for every token
 *  that resolves to a workspace file. */
export function draftToInline(
  isPath: (token: string) => boolean,
  draft: string,
): JSONContent[] {
  const inline: JSONContent[] = [];
  for (const line of draft.split("\n")) {
    if (inline.length > 0) inline.push({ type: "hardBreak" });
    for (const segment of segmentMentions(line, isPath)) {
      if (segment.type === "text") {
        if (segment.value) inline.push({ type: "text", text: segment.value });
      } else {
        inline.push({
          type: "mention",
          attrs: {
            id: segment.value,
            label: segment.value.slice(segment.value.lastIndexOf("/") + 1),
          },
        });
      }
    }
  }
  return inline;
}

/** A whole `promptDraft` node holding `draft` — what a ranged replace at a
 *  widget's content puts there (Edit, Escape-restore, send clearing it). */
export function draftToNode(
  isPath: (token: string) => boolean,
  draft: string,
): JSONContent {
  const content = draftToInline(isPath, draft);
  return {
    type: PROMPT_DRAFT_NODE_NAME,
    ...(content.length ? { content } : {}),
  };
}

/** The standalone composer's document (chat tab) — one paragraph. */
export function draftToDoc(
  isPath: (token: string) => boolean,
  draft: string,
): JSONContent {
  const content = draftToInline(isPath, draft);
  return {
    type: "doc",
    content: [{ type: "paragraph", ...(content.length ? { content } : {}) }],
  };
}

/** A chip's draft text — the one place the `@<relativePath>` form is
 *  produced, so both readers below agree. */
function mentionText(node: PMNode): string {
  return `@${node.attrs.id ?? ""}`;
}

/** For `editor.getText()` on the standalone composer's document. */
export const DRAFT_TEXT_SERIALIZERS = {
  hardBreak: () => "\n",
  mention: ({ node }: { node: PMNode }) => mentionText(node),
};

/**
 * A node's text as the plain draft string: chips back to the literal
 * `@<relativePath>` the submit paths re-parse, hard breaks back to
 * newlines. One implementation for the widget's draft node and for the
 * standalone composer's paragraph, which is what keeps the two surfaces
 * byte-for-byte agreed.
 */
export function readDraftNode(node: PMNode): string {
  return node.textBetween(0, node.content.size, "\n", (leaf) =>
    leaf.type.name === "mention" ? mentionText(leaf) : "",
  );
}
