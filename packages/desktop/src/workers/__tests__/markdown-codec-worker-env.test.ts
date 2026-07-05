// @vitest-environment node
/**
 * Runs the markdown codec with ONLY the linkedom worker shim — no happy-dom,
 * no browser. This is the environment the conversion worker actually runs
 * in; any hidden real-DOM dependency in the codec's parse/serialize paths
 * fails here instead of at runtime inside the worker.
 *
 * Canonical fixtures assert byte-identity (parse → serialize). The editor
 * equivalence itself is pinned separately in
 * components/editor/__tests__/markdown-codec.test.ts.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { installWorkerDomShim } from "../worker-dom-shim";
import type { MarkdownCodec } from "../../components/editor/markdown-codec";

let codec: MarkdownCodec;

beforeAll(async () => {
  expect(typeof document).toBe("undefined");
  installWorkerDomShim();
  const { createMarkdownCodec } = await import(
    "../../components/editor/markdown-codec"
  );
  codec = createMarkdownCodec();
});

const canonicalFixtures = [
  "Hello world",
  "First\n\nSecond",
  "# Heading",
  "Some **bold** text",
  "Some *italic* text",
  "Some ~~struck~~ text",
  "Some `code` text",
  "Visit [example](https://example.com) today",
  "> Quoted text",
  "Above\n\n---\n\nBelow",
  "- one\n- two\n- three",
  "- parent\n  - child\n  - child two",
  "1. one\n2. two\n3. three",
  "```ts\nconst x = 1;\n```",
  "- [ ] todo",
  "- [x] done",
  "- [ ] first\n- [ ]\n- [x] third",
  "- [ ] first\n\n- [x] second",
  "Some <u>underlined</u> text",
  "Some <mark>highlighted</mark> text",
  "H<sub>2</sub>O",
  "x<sup>2</sup>",
  "Before\n\n![alt text](assets/pic.png)\n\nAfter",
];

describe("codec under linkedom shim (worker environment)", () => {
  it.each(canonicalFixtures.map((f) => [f.slice(0, 40), f]))(
    "identity round-trip: %s",
    (_label, md) => {
      expect(codec.serialize(codec.parse(md))).toBe(md);
    },
  );

  it("normalizing input reaches a fixed point", () => {
    const once = codec.serialize(codec.parse("* one\n* two"));
    expect(once).toBe("- one\n- two");
    expect(codec.serialize(codec.parse(once))).toBe(once);
  });

  it("tables round-trip to a fixed point", () => {
    const table =
      "| Name | Age |\n| --- | --- |\n| Alice | 30 |\n| Bob | 25 |";
    const once = codec.serialize(codec.parse(table));
    expect(once).toContain("| Alice | 30 |");
    expect(codec.serialize(codec.parse(once))).toBe(once);
  });

  it("empty document serializes to empty string", () => {
    expect(codec.serialize(codec.parse(""))).toBe("");
  });

  it("hash is computable without DOM", () => {
    expect(codec.hash("abc")).toBe("900150983cd24fb0d6963f7d28e17f72");
  });
});
