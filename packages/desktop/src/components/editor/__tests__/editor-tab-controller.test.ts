import { afterEach, describe, expect, it } from "vitest";
import {
  getOrCreateEditor,
  disposeAllEditors,
  getMarkdownEditor,
} from "@/components/editor/editor-store";
import { getTabController } from "@/tabs/tab-controllers";

function doc(...paragraphs: string[]) {
  return {
    type: "doc",
    content: paragraphs.map((text) => ({
      type: "paragraph",
      content: [{ type: "text", text }],
    })),
  };
}

afterEach(() => {
  disposeAllEditors();
});

describe("a document's tab controller", () => {
  it("round-trips find-in-tab: what search finds, revealMatch selects", () => {
    getOrCreateEditor("/ws/a.md", {
      type: "markdown",
      content: doc("alpha beta", "beta gamma"),
    });

    const tab = getTabController("/ws/a.md")!;
    const matches = tab.search("beta");
    expect(matches).toEqual([
      { matchText: "beta", lineText: "alpha beta", occurrence: 0 },
      { matchText: "beta", lineText: "beta gamma", occurrence: 1 },
    ]);

    expect(tab.revealMatch(matches[1])).toBe(true);
    const editor = getMarkdownEditor("/ws/a.md")!;
    const { from, to } = editor.state.selection;
    expect(editor.state.doc.textBetween(from, to)).toBe("beta");
    // The second occurrence — the one on the second line.
    expect(from).toBeGreaterThan("alpha beta".length);
  });

  it("undoes through the document's own history", () => {
    getOrCreateEditor("/ws/a.md", { type: "markdown", content: doc("alpha") });
    const editor = getMarkdownEditor("/ws/a.md")!;
    editor.commands.insertContentAt(editor.state.doc.content.size - 1, " beta");
    expect(editor.state.doc.textContent).toContain("beta");

    getTabController("/ws/a.md")!.history!.undo();
    expect(editor.state.doc.textContent).not.toContain("beta");
  });

  it("has no history or searchable content on a non-document tab", () => {
    getOrCreateEditor("/ws/pic.png", { type: "image" });
    const tab = getTabController("/ws/pic.png")!;

    expect(tab.history).toBeUndefined();
    expect(tab.search("anything")).toEqual([]);
  });
});
