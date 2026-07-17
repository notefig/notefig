import { composePrompt } from "./prompt-composer";

describe("composePrompt", () => {
  it("plain text produces the same shape as the pre-Stage-1 hardcoded block", () => {
    const blocks = composePrompt({
      text: "hello",
      capabilities: { embeddedContext: true },
    });
    expect(blocks).toEqual([{ type: "text", text: "hello" }]);
  });

  it("emits an embeddedContext resource block when the capability is on", () => {
    const blocks = composePrompt({
      text: "look at this",
      contextParts: [
        { kind: "embedded", path: "notes.md", content: "draft content" },
      ],
      capabilities: { embeddedContext: true },
    });
    expect(blocks).toHaveLength(2);
    expect(blocks[1]).toMatchObject({
      type: "resource",
      resource: { uri: "notes.md", text: "draft content" },
    });
  });

  it("degrades embedded context to inline fenced text when unsupported", () => {
    const blocks = composePrompt({
      text: "look at this",
      contextParts: [
        { kind: "embedded", path: "notes.md", content: "draft content" },
      ],
      capabilities: { embeddedContext: false },
    });
    expect(blocks).toHaveLength(2);
    expect(blocks[1].type).toBe("text");
    expect((blocks[1] as { text: string }).text).toContain("draft content");
    expect(blocks.some((b) => b.type === "resource")).toBe(false);
  });

  it("always emits resource_link regardless of embeddedContext capability", () => {
    const blocks = composePrompt({
      text: "see",
      contextParts: [{ kind: "resource_link", path: "chapter-2.md" }],
      capabilities: { embeddedContext: false },
    });
    expect(blocks[1]).toMatchObject({ type: "resource_link", uri: "chapter-2.md" });
  });
});
