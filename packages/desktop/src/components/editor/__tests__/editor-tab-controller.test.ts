import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getOrCreateEditor,
  disposeAllEditors,
  type EditorFs,
} from "@/components/editor/editor-store";
import { createEditors } from "@/entities/editors";
import { getTabController } from "@/tabs/tab-controllers";

const editors = createEditors();

function doc(...paragraphs: string[]) {
  return {
    type: "doc",
    content: paragraphs.map((text) => ({
      type: "paragraph",
      content: [{ type: "text", text }],
    })),
  };
}

/** The platform fs an editor reaches. Nothing here searches the workspace
 *  or pastes an image, so it answers empty. */
const fs: EditorFs = {
  searchContent: vi.fn(async () => []),
  exists: vi.fn(async (paths: string[]) =>
    paths.map((path) => ({ path, exists: false })),
  ),
  writeBinaryFiles: vi.fn(async () => ({ succeeded: [], failed: [] })),
};

afterEach(() => {
  disposeAllEditors(editors);
});

describe("a document's tab controller", () => {
  it("reveals a match by re-locating it in the rendered document", async () => {
    getOrCreateEditor(
      editors,
      "/ws/a.md",
      {
        type: "markdown",
        content: doc("alpha beta", "beta gamma"),
      },
      fs,
    );

    // The shape the file search returns: text, its line, and which
    // same-text occurrence in the file it was.
    editors.markMounted("/ws/a.md");
    const revealed = await getTabController("/ws/a.md")!.revealMatch({
      matchText: "beta",
      lineText: "beta gamma",
      occurrence: 1,
    });
    expect(revealed).toBe(true);

    const editor = editors.markdownEditor("/ws/a.md")!;
    const { from, to } = editor.state.selection;
    expect(editor.state.doc.textBetween(from, to)).toBe("beta");
    // The second occurrence — the one on the second line.
    expect(from).toBeGreaterThan("alpha beta".length);
  });

  it("undoes through the document's own history", () => {
    getOrCreateEditor(
      editors,
      "/ws/a.md",
      { type: "markdown", content: doc("alpha") },
      fs,
    );
    const editor = editors.markdownEditor("/ws/a.md")!;
    editor.commands.insertContentAt(editor.state.doc.content.size - 1, " beta");
    expect(editor.state.doc.textContent).toContain("beta");

    getTabController("/ws/a.md")!.history!.undo();
    expect(editor.state.doc.textContent).not.toContain("beta");
  });

  it("has no history or searchable content on a non-document tab", async () => {
    getOrCreateEditor(editors, "/ws/pic.png", { type: "image" }, fs);
    const tab = getTabController("/ws/pic.png")!;

    expect(tab.history).toBeUndefined();
    await expect(tab.search("anything")).resolves.toEqual([]);
  });
});
