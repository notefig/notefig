/**
 * Pure logic behind the frontmatter properties popover: the structured/raw
 * fallback decision, byte-preserving yaml edits (what autosave writes into
 * the user's file), and value-type resolution/parsing.
 */
import { describe, it, expect } from "vitest";
import {
  analyzeFrontmatter,
  deleteFrontmatterKey,
  renameFrontmatterKey,
  setFrontmatterKey,
} from "../frontmatter-popover";
import {
  parseScalarInput,
  resolveValueType,
} from "../frontmatter-value-types";

describe("analyzeFrontmatter", () => {
  it("flat string-keyed map is structured", () => {
    const result = analyzeFrontmatter("title: Hello\ncount: 3");
    expect(result.structured).toBe(true);
    expect(result.rows).toEqual([
      { key: "title", value: "Hello" },
      { key: "count", value: 3 },
    ]);
  });

  it("non-string keys fall back to raw (edits would target the wrong key)", () => {
    const result = analyzeFrontmatter("1: x\ntitle: y");
    expect(result.structured).toBe(false);
    expect(result.parseError).toBe(false);
  });

  it("invalid yaml reports parseError and falls back to raw", () => {
    const result = analyzeFrontmatter("title: [unclosed");
    expect(result.structured).toBe(false);
    expect(result.parseError).toBe(true);
  });
});

describe("yaml edits preserve untouched bytes", () => {
  const YAML = "# reviewed 2026-08\nzeta: 1\nalpha: 2";

  it("set keeps comments and key order", () => {
    expect(setFrontmatterKey(YAML, "zeta", 9)).toBe(
      "# reviewed 2026-08\nzeta: 9\nalpha: 2",
    );
  });

  it("rename keeps the entry's position and comment", () => {
    expect(renameFrontmatterKey(YAML, "zeta", "omega")).toBe(
      "# reviewed 2026-08\nomega: 1\nalpha: 2",
    );
  });

  it("rename onto an existing key is a no-op", () => {
    expect(renameFrontmatterKey(YAML, "zeta", "alpha")).toBe(YAML);
  });

  it("deleting the last key returns empty text (drops the fences on save)", () => {
    expect(deleteFrontmatterKey("title: x", "title")).toBe("");
  });
});

describe("parseScalarInput", () => {
  it("preserves YAML scalar types", () => {
    expect(parseScalarInput("hello")).toBe("hello");
    expect(parseScalarInput("3")).toBe(3);
    expect(parseScalarInput("true")).toBe(true);
  });

  it("comma-separated input becomes a list of typed scalars", () => {
    expect(parseScalarInput("a, 2, true")).toEqual(["a", 2, true]);
  });

  it("input that would parse to an object stays the literal string", () => {
    expect(parseScalarInput("key: value")).toBe("key: value");
  });
});

describe("resolveValueType", () => {
  it.each([
    ["boolean", true],
    ["date", "2026-08-26"],
    ["cron", "*/5 * * * *"],
    ["list", ["a", "b"]],
    ["yaml", { nested: "map" }],
    ["text", "plain string"],
    ["text", "2026-13-45"], // date-shaped but not a valid date
    ["text", "* * *"], // too few fields for cron
  ])("resolves %s for %j", (name, value) => {
    expect(resolveValueType(value).name).toBe(name);
  });
});
