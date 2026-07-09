import { describe, it, expect } from "vitest";
import { findToolFence } from "../tool-fence";

describe("findToolFence", () => {
  it("returns none when there's no fence", () => {
    expect(findToolFence("just some prose")).toEqual({ kind: "none" });
  });

  it("parses a complete well-formed fence", () => {
    const text = [
      "I'll start by listing the documents.",
      "```metrists:tool",
      "name: workspace_list_documents",
      "input:",
      "  {}",
      "```",
    ].join("\n");
    const result = findToolFence(text);
    expect(result).toMatchObject({ kind: "match", name: "workspace_list_documents" });
  });

  it("parses input fields", () => {
    const text = [
      "```metrists:tool",
      "name: workspace_read_document",
      "input:",
      "  path: notes/pricing.md",
      "```",
    ].join("\n");
    const result = findToolFence(text);
    expect(result).toEqual({
      kind: "match",
      name: "workspace_read_document",
      input: { path: "notes/pricing.md" },
      raw: expect.stringContaining("workspace_read_document"),
    });
  });

  it("reports an unclosed fence as incomplete, not none", () => {
    const text = "```metrists:tool\nname: workspace_list_documents\ninput:\n  {}";
    expect(findToolFence(text)).toEqual({ kind: "incomplete" });
  });

  it("reports invalid YAML as malformed", () => {
    const text = "```metrists:tool\nname: [unterminated\n```";
    const result = findToolFence(text);
    expect(result.kind).toBe("malformed");
  });

  it("reports a missing name field as malformed", () => {
    const text = "```metrists:tool\ninput:\n  {}\n```";
    const result = findToolFence(text);
    expect(result).toMatchObject({ kind: "malformed" });
  });

  it("ignores a normal code fence with a different language tag", () => {
    const text = "```typescript\nconst x = 1;\n```";
    expect(findToolFence(text)).toEqual({ kind: "none" });
  });
});
