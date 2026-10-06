import { describe, it, expect, afterEach, vi } from "vitest";
import {
  getOrCreateEditor,
  disposeEditor,
  disposeAllEditors,
  saveSelection,
  getSavedSelection,
  whenBlockRendered,
  type EditorFs,
} from "@/components/editor/editor-store";
import { createEditors, isMarkdownInstance } from "@/entities/editors";

/** The registry the surfaces fill — one per test file, cleared after each. */
const editors = createEditors();
const hasEditor = (path: string) => editors.instance(path) !== undefined;
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

describe("editor registry", () => {
  it("returns the same instance for the same path", () => {
    const a = getOrCreateEditor(editors, "/ws/a.md", MD_CONFIG, fs);
    const again = getOrCreateEditor(editors, "/ws/a.md", MD_CONFIG, fs);
    expect(again).toBe(a);
  });

  it("returns distinct instances per path", () => {
    const a = getOrCreateEditor(editors, "/ws/a.md", MD_CONFIG, fs);
    const b = getOrCreateEditor(editors, "/ws/b.md", MD_CONFIG, fs);
    expect(b).not.toBe(a);
  });

  it("routes markdown and image configs to the right instance types", () => {
    const md = getOrCreateEditor(editors, "/ws/a.md", MD_CONFIG, fs);
    const img = getOrCreateEditor(editors, "/ws/pic.png", { type: "image" }, fs);

    expect(isMarkdownInstance(md)).toBe(true);
    expect(md.type).not.toBe("image");
    expect(img.type).toBe("image");
    expect(isMarkdownInstance(img)).toBe(false);
  });

  it("disposeEditor destroys and forgets the instance", () => {
    getOrCreateEditor(editors, "/ws/a.md", MD_CONFIG, fs);
    expect(hasEditor("/ws/a.md")).toBe(true);

    disposeEditor(editors, "/ws/a.md");
    expect(hasEditor("/ws/a.md")).toBe(false);
    expect(editors.instance("/ws/a.md")).toBeUndefined();
  });

  it("disposeAllEditors clears the registry", () => {
    getOrCreateEditor(editors, "/ws/a.md", MD_CONFIG, fs);
    getOrCreateEditor(editors, "/ws/b.md", MD_CONFIG, fs);

    disposeAllEditors(editors);
    expect(hasEditor("/ws/a.md")).toBe(false);
    expect(hasEditor("/ws/b.md")).toBe(false);
  });

  it("a re-created path gets a fresh editor", () => {
    const first = getOrCreateEditor(editors, "/ws/a.md", MD_CONFIG, fs);
    disposeEditor(editors, "/ws/a.md");
    const second = getOrCreateEditor(editors, "/ws/a.md", MD_CONFIG, fs);
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
    getOrCreateEditor(editors, path, EMPTY_CONFIG, fs);
    // Tab intents are only eligible for the arbiter's active tab.
    setActiveTab(path);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const blobId = findPromptNodeId(editors.markdownEditor(path)!.state.doc);
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
    const editor = editors.markdownEditor("/ws/empty.md")!;
    expect(selectionDraft(editor.state)?.blobId).toBe(blobId);
  });

  it("keeps the caret there across an ambient tab intent", async () => {
    const blobId = await emptyKeeperDoc("/ws/empty-intent.md");

    requestTabFocus("/ws/empty-intent.md", { reason: "tab-selected" });
    await new Promise((resolve) => setTimeout(resolve, 0)); // microtask flush

    const editor = editors.markdownEditor("/ws/empty-intent.md")!;
    expect(selectionDraft(editor.state)?.blobId).toBe(blobId);
  });

  it("leaves documents with content alone", async () => {
    getOrCreateEditor(editors, "/ws/full.md", MD_CONFIG, fs);
    setActiveTab("/ws/full.md");
    await new Promise((resolve) => setTimeout(resolve, 0));

    requestTabFocus("/ws/full.md", { reason: "tab-selected" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(findPromptNodeId(editors.markdownEditor("/ws/full.md")!.state.doc)).toBe(
      null,
    );
  });
});

describe("selection persistence", () => {
  it("round-trips a saved selection", () => {
    getOrCreateEditor(editors, "/ws/a.md", MD_CONFIG, fs);
    saveSelection(editors, "/ws/a.md", 2, 5);
    expect(getSavedSelection(editors, "/ws/a.md")).toEqual({ from: 2, to: 5 });
  });

  it("returns undefined for unknown paths", () => {
    expect(getSavedSelection(editors, "/ws/never-opened.md")).toBeUndefined();
  });
});

describe("getSelectedText", () => {
  it("returns the text inside the current selection", () => {
    const instance = getOrCreateEditor(editors, "/ws/a.md", MD_CONFIG, fs);
    if (!isMarkdownInstance(instance)) throw new Error("expected markdown");

    instance.editor.commands.setTextSelection({ from: 1, to: 6 });
    expect(editors.selectedText("/ws/a.md")).toBe("Hello");
  });
});

describe("goTo", () => {
  const beta = {
    matchText: "beta",
    lineText: "Alpha beta gamma",
    occurrence: 0,
  };

  it("is false for a path no editor mounts in time", async () => {
    expect(await editors.goTo("/ws/never-opened.md", beta, 10)).toBe(false);
  });

  it("selects the matched text once the editor is mounted", async () => {
    // Match→position mapping across markdown constructs is covered
    // exhaustively by go-to-location.test.ts; this only checks the
    // orchestration wiring.
    getOrCreateEditor(
      editors,
      "/ws/a.md",
      {
        type: "markdown",
        content: docWithText("Alpha beta gamma"),
      },
      fs,
    );
    editors.markMounted("/ws/a.md");

    expect(await editors.goTo("/ws/a.md", beta)).toBe(true);

    const editor = editors.markdownEditor("/ws/a.md");
    const { from, to } = editor!.state.selection;
    expect(editor!.state.doc.textBetween(from, to)).toBe("beta");
  });

  it("waits for a mount that has not happened yet", async () => {
    const landed = editors.goTo("/ws/a.md", beta);
    // The tab opens and its editor mounts after the request.
    getOrCreateEditor(
      editors,
      "/ws/a.md",
      {
        type: "markdown",
        content: docWithText("Alpha beta gamma"),
      },
      fs,
    );
    editors.markMounted("/ws/a.md");

    expect(await landed).toBe(true);
    const editor = editors.markdownEditor("/ws/a.md");
    const { from, to } = editor!.state.selection;
    expect(editor!.state.doc.textBetween(from, to)).toBe("beta");
  });
});

describe("whenBlockRendered", () => {
  // ProseMirror owns its view's DOM and reverts foreign nodes, so the wait
  // is exercised against a plain root standing in for the view.
  const fakeEditor = (root: HTMLElement) =>
    ({ view: { dom: root } }) as unknown as Parameters<
      typeof whenBlockRendered
    >[0];

  it("resolves once the block's node view renders", async () => {
    const root = document.createElement("div");
    const found = whenBlockRendered(fakeEditor(root), "blob-1");
    const block = document.createElement("div");
    block.dataset.blobId = "blob-1";
    root.append(block);
    expect(await found).toBe(block);
  });

  it("gives up with null when the block never renders", async () => {
    vi.useFakeTimers();
    try {
      const found = whenBlockRendered(
        fakeEditor(document.createElement("div")),
        "missing",
      );
      vi.advanceTimersByTime(2_000);
      expect(await found).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("whenBlockRendered, late id", () => {
  it("resolves when an existing wrapper gains the block id", async () => {
    const root = document.createElement("div");
    const wrapper = document.createElement("div");
    root.append(wrapper);
    const found = whenBlockRendered(
      { view: { dom: root } } as unknown as Parameters<
        typeof whenBlockRendered
      >[0],
      "blob-2",
    );
    wrapper.dataset.blobId = "blob-2";
    expect(await found).toBe(wrapper);
  });
});
