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
    expect(navigateToLocation("/ws/never-opened.md", { line: 1 })).toBe(false);
  });

  it("moves the selection to the requested column", () => {
    // Line→position mapping across blocks is covered exhaustively by
    // go-to-location.test.ts; this only checks the orchestration wiring.
    getOrCreateEditor("/ws/a.md", MD_CONFIG);

    expect(navigateToLocation("/ws/a.md", { line: 1, column: 7 })).toBe(true);

    const editor = getMarkdownEditor("/ws/a.md");
    const { from } = editor!.state.selection;
    expect(editor!.state.doc.textBetween(from, from + 5)).toBe("world");
  });

  it("selects the expectedText when it can be found", () => {
    getOrCreateEditor("/ws/a.md", {
      type: "markdown",
      content: docWithText("Alpha beta gamma"),
    });

    expect(
      navigateToLocation("/ws/a.md", {
        line: 1,
        column: 7,
        expectedText: "beta",
      }),
    ).toBe(true);

    const editor = getMarkdownEditor("/ws/a.md");
    const { from, to } = editor!.state.selection;
    expect(editor!.state.doc.textBetween(from, to)).toBe("beta");
  });
});
