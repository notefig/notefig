import { describe, it, expect, afterEach } from "vitest";
import {
  getOrCreateEditor,
  isMarkdownInstance,
  isImageInstance,
  getEditor,
  hasEditor,
  disposeEditor,
  disposeAllEditors,
  saveSelection,
  getSavedSelection,
  getSelectedText,
  navigateToLocation,
  getMarkdownEditor,
} from "@/components/editor/editor-store";
import { requestTabFocus, setActiveTab } from "@/tabs/tab-controllers";
import { findPromptNodeId, selectionDraft } from "@notefig/widgets";

/** Editors accept only parsed doc JSON (conversion happens in the worker). */
function docWithText(text: string) {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

const MD_CONFIG = {
  type: "markdown" as const,
  content: docWithText("Hello world"),
};

afterEach(() => {
  disposeAllEditors();
});

describe("editor registry", () => {
  it("returns the same instance for the same path", () => {
    const a = getOrCreateEditor("/ws/a.md", MD_CONFIG);
    const again = getOrCreateEditor("/ws/a.md", MD_CONFIG);
    expect(again).toBe(a);
  });

  it("returns distinct instances per path", () => {
    const a = getOrCreateEditor("/ws/a.md", MD_CONFIG);
    const b = getOrCreateEditor("/ws/b.md", MD_CONFIG);
    expect(b).not.toBe(a);
  });

  it("routes markdown and image configs to the right instance types", () => {
    const md = getOrCreateEditor("/ws/a.md", MD_CONFIG);
    const img = getOrCreateEditor("/ws/pic.png", { type: "image" });

    expect(isMarkdownInstance(md)).toBe(true);
    expect(isImageInstance(md)).toBe(false);
    expect(isImageInstance(img)).toBe(true);
    expect(isMarkdownInstance(img)).toBe(false);
  });

  it("disposeEditor destroys and forgets the instance", () => {
    getOrCreateEditor("/ws/a.md", MD_CONFIG);
    expect(hasEditor("/ws/a.md")).toBe(true);

    disposeEditor("/ws/a.md");
    expect(hasEditor("/ws/a.md")).toBe(false);
    expect(getEditor("/ws/a.md")).toBeUndefined();
  });

  it("disposeAllEditors clears the registry", () => {
    getOrCreateEditor("/ws/a.md", MD_CONFIG);
    getOrCreateEditor("/ws/b.md", MD_CONFIG);

    disposeAllEditors();
    expect(hasEditor("/ws/a.md")).toBe(false);
    expect(hasEditor("/ws/b.md")).toBe(false);
  });

  it("a re-created path gets a fresh editor", () => {
    const first = getOrCreateEditor("/ws/a.md", MD_CONFIG);
    disposeEditor("/ws/a.md");
    const second = getOrCreateEditor("/ws/a.md", MD_CONFIG);
    expect(second).not.toBe(first);
  });
});

describe("empty-document keeper", () => {
  const EMPTY_CONFIG = {
    type: "markdown" as const,
    content: { type: "doc", content: [{ type: "paragraph" }] },
  };

  /** Store-created empty doc with the keeper inserted (onCreate is async). */
  async function emptyKeeperDoc(path: string): Promise<string> {
    getOrCreateEditor(path, EMPTY_CONFIG);
    // Tab intents are only eligible for the arbiter's active tab.
    setActiveTab(path);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const blobId = findPromptNodeId(getMarkdownEditor(path)!.state.doc);
    expect(blobId).toBeTruthy();
    return blobId!;
  }

  afterEach(() => {
    setActiveTab(null);
  });

  // The arbiter used to need a carve-out here: the composer was a separate
  // editor, so "focus this tab" had to be redirected to it on an empty doc.
  // The draft is document content now, so the caret is simply already
  // there, and an ordinary tab intent lands on it.
  it("opens with the caret in the keeper's draft", async () => {
    const blobId = await emptyKeeperDoc("/ws/empty.md");
    const editor = getMarkdownEditor("/ws/empty.md")!;
    expect(selectionDraft(editor.state)?.blobId).toBe(blobId);
  });

  it("keeps the caret there across an ambient tab intent", async () => {
    const blobId = await emptyKeeperDoc("/ws/empty-intent.md");

    requestTabFocus("/ws/empty-intent.md", { reason: "tab-selected" });
    await new Promise((resolve) => setTimeout(resolve, 0)); // microtask flush

    const editor = getMarkdownEditor("/ws/empty-intent.md")!;
    expect(selectionDraft(editor.state)?.blobId).toBe(blobId);
  });

  it("leaves documents with content alone", async () => {
    getOrCreateEditor("/ws/full.md", MD_CONFIG);
    setActiveTab("/ws/full.md");
    await new Promise((resolve) => setTimeout(resolve, 0));

    requestTabFocus("/ws/full.md", { reason: "tab-selected" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(findPromptNodeId(getMarkdownEditor("/ws/full.md")!.state.doc)).toBe(
      null,
    );
  });
});

describe("selection persistence", () => {
  it("round-trips a saved selection", () => {
    getOrCreateEditor("/ws/a.md", MD_CONFIG);
    saveSelection("/ws/a.md", 2, 5);
    expect(getSavedSelection("/ws/a.md")).toEqual({ from: 2, to: 5 });
  });

  it("returns undefined for unknown paths", () => {
    expect(getSavedSelection("/ws/never-opened.md")).toBeUndefined();
  });
});

describe("getSelectedText", () => {
  it("returns the text inside the current selection", () => {
    const instance = getOrCreateEditor("/ws/a.md", MD_CONFIG);
    if (!isMarkdownInstance(instance)) throw new Error("expected markdown");

    instance.editor.commands.setTextSelection({ from: 1, to: 6 });
    expect(getSelectedText("/ws/a.md")).toBe("Hello");
  });
});

describe("navigateToLocation", () => {
  it("returns false for unknown paths", () => {
    expect(
      navigateToLocation("/ws/never-opened.md", {
        matchText: "x",
        lineText: "x",
        occurrence: 0,
      }),
    ).toBe(false);
  });

  it("selects the matched text", () => {
    // Match→position mapping across markdown constructs is covered
    // exhaustively by go-to-location.test.ts; this only checks the
    // orchestration wiring.
    getOrCreateEditor("/ws/a.md", {
      type: "markdown",
      content: docWithText("Alpha beta gamma"),
    });

    expect(
      navigateToLocation("/ws/a.md", {
        matchText: "beta",
        lineText: "Alpha beta gamma",
        occurrence: 0,
      }),
    ).toBe(true);

    const editor = getMarkdownEditor("/ws/a.md");
    const { from, to } = editor!.state.selection;
    expect(editor!.state.doc.textBetween(from, to)).toBe("beta");
  });
});
