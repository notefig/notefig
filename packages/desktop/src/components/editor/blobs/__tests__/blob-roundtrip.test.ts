/**
 * Validates the core blob design bet: a deferred blob is nothing but a
 * fenced code block with a metrists:<type> language tag, so it must
 * round-trip byte-identically through the existing markdown codec with no
 * schema or codec changes. If this ever breaks, the blob system's
 * round-trip-by-construction guarantee is gone.
 */
import { describe, it, expect } from "vitest";
import { createMarkdownCodec } from "../../markdown-codec";

const codec = createMarkdownCodec();

const blobFixtures: string[] = [
  // canonical pending question
  "```notefig:question\nid: q_8f2a\nstatus: pending\nprompt: Which pricing tier does this doc target?\noptions: [Free, Pro, Enterprise]\n```",
  // answered, with unknown keys and a YAML comment that must survive
  "```notefig:question\nid: q_8f2a\nstatus: answered\nprompt: Which tier?\nanswer: Pro\nansweredAt: 2026-07-05T00:00:00Z\n# agent-added note\nx-agent-meta: keep-me\n```",
  "```notefig:approval\nid: ap_1b2c\nstatus: pending\nprompt: Delete the old chapter?\n```",
  "```notefig:status\nid: st_9d4e\nstatus: pending\ntitle: Rewriting introduction\nstate: working\n```",
  // blob embedded between normal blocks
  "# Doc\n\nIntro paragraph.\n\n```notefig:question\nid: q_zz99\nstatus: pending\nprompt: Keep this section?\n```\n\nAfter the blob.",
  // invalid YAML must still round-trip as a plain code block
  "```notefig:question\nnot: [valid: yaml\n```",
  // nested inside a list item
  "- Context item\n\n  ```notefig:question\n  id: q_l1st\n  status: pending\n  prompt: Nested in a list?\n  ```",
  // nested inside a blockquote
  "> ```notefig:question\n> id: q_bq99\n> status: pending\n> prompt: Nested in a blockquote?\n> ```",
];

describe("blob fenced blocks round-trip through the markdown codec", () => {
  for (const markdown of blobFixtures) {
    it(`round-trips: ${markdown.slice(0, 48).replace(/\n/g, "⏎")}…`, () => {
      const doc = codec.parse(markdown);
      expect(codec.serialize(doc)).toBe(markdown);
    });
  }
});
