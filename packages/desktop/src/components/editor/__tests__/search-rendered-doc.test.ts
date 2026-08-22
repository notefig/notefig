import { describe, expect, it } from "vitest";
import {
  getOrCreateEditor,
  disposeAllEditors,
  getMarkdownEditor,
} from "@/components/editor/editor-store";
import { getTabController } from "@/tabs/tab-controllers";
import { searchRenderedDoc } from "@/components/editor/editor-position";
import { afterEach } from "vitest";

function doc(...paragraphs: string[]) {
  return {
    type: "doc",
    content: paragraphs.map((text) => ({
      type: "paragraph",
      content: text ? [{ type: "text", text }] : undefined,
    })),
  };
}

afterEach(() => {
  disposeAllEditors();
});

describe("searchRenderedDoc", () => {
  it("returns one match per occurrence, numbered per matched text", () => {
    getOrCreateEditor("/ws/a.md", {
      type: "markdown",
      content: doc("alpha beta", "beta gamma"),
    });
    const rendered = getMarkdownEditor("/ws/a.md")!.state.doc;

    expect(searchRenderedDoc(rendered, "beta")).toEqual([
      { matchText: "beta", lineText: "alpha beta", occurrence: 0 },
      { matchText: "beta", lineText: "beta gamma", occurrence: 1 },
    ]);
  });

  it("is case-insensitive by default and reports the text as written", () => {
    getOrCreateEditor("/ws/a.md", {
      type: "markdown",
      content: doc("Beta and beta"),
    });
    const rendered = getMarkdownEditor("/ws/a.md")!.state.doc;

    expect(searchRenderedDoc(rendered, "beta").map((m) => m.matchText)).toEqual(
      ["Beta", "beta"],
    );
    expect(
      searchRenderedDoc(rendered, "beta", { caseSensitive: true }),
    ).toEqual([
      { matchText: "beta", lineText: "Beta and beta", occurrence: 0 },
    ]);
  });

  it("finds nothing for an empty query", () => {
    getOrCreateEditor("/ws/a.md", { type: "markdown", content: doc("alpha") });
    expect(
      searchRenderedDoc(getMarkdownEditor("/ws/a.md")!.state.doc, ""),
    ).toEqual([]);
  });
});

describe("a file tab's find-in-tab", () => {
  it("round-trips: what search finds, revealMatch selects", () => {
    getOrCreateEditor("/ws/a.md", {
      type: "markdown",
      content: doc("alpha beta", "beta gamma"),
    });

    const tab = getTabController("/ws/a.md")!;
    const matches = tab.search("beta");
    expect(matches).toHaveLength(2);

    expect(tab.revealMatch(matches[1])).toBe(true);

    const editor = getMarkdownEditor("/ws/a.md")!;
    const { from, to } = editor.state.selection;
    expect(editor.state.doc.textBetween(from, to)).toBe("beta");
    // The second occurrence: the one on the second line.
    expect(from).toBeGreaterThan("alpha beta".length);
  });

  it("has no history on a tab that isn't a document", () => {
    getOrCreateEditor("/ws/pic.png", { type: "image" });
    expect(getTabController("/ws/pic.png")!.history).toBeUndefined();
    expect(getTabController("/ws/pic.png")!.search("anything")).toEqual([]);
  });

  it("undoes through the document's own history", () => {
    getOrCreateEditor("/ws/a.md", { type: "markdown", content: doc("alpha") });
    const editor = getMarkdownEditor("/ws/a.md")!;
    editor.commands.insertContentAt(editor.state.doc.content.size - 1, " beta");
    expect(editor.state.doc.textContent).toContain("beta");

    getTabController("/ws/a.md")!.history!.undo();
    expect(editor.state.doc.textContent).not.toContain("beta");
  });
});
