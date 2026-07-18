/**
 * Integration tests for the worker-backed save pipeline in useEditorFileSync:
 * edits ship as they come (no debounce), coalesce under backpressure, and
 * still save when the conversion worker is unavailable (inline fallback —
 * which is also the path this happy-dom environment exercises, since it has
 * no real module workers).
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createElement } from "react";
import { Editor } from "@tiptap/core";
import { editorExtensions } from "@/components/editor/tiptap-editor-kit";
import type { FileEntry } from "@/utils/fs";
import { calculateContentHash } from "@/utils/hash";

vi.mock("@/utils/collections", () => ({
  writeFileContent: vi.fn(async () => {}),
}));

import { writeFileContent } from "@/utils/collections";
import {
  parseMarkdown,
  serializeDoc,
  resetConverterForTests,
  closeDocumentSync,
  flushDocumentSync,
} from "@/utils/markdown-conversion";
import { useEditorFileSync } from "../use-editor-file-sync";

const writeFileContentMock = vi.mocked(writeFileContent);

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => {
  // No real module workers here: force the deterministic inline fallback,
  // which doubles as the worker-boot-failure regression test.
  vi.stubGlobal(
    "Worker",
    class {
      constructor() {
        throw new Error("Workers unavailable in this environment");
      }
    },
  );
  resetConverterForTests();
});

let editor: Editor;
let root: Root;
let container: HTMLElement;

interface HarnessProps {
  file: FileEntry;
}

function Harness({ file }: HarnessProps) {
  useEditorFileSync(editor, file, "/ws", true);
  return null;
}

function makeFile(content: string): FileEntry {
  return {
    path: "/ws/note.md",
    type: "file",
    content,
    contentHash: calculateContentHash(content),
  };
}

async function render(file: FileEntry) {
  await act(async () => {
    root.render(createElement(Harness, { file }));
  });
}

beforeEach(async () => {
  writeFileContentMock.mockClear();
  editor = new Editor({
    extensions: editorExtensions,
    content: "start",
    editable: true,
    autofocus: false,
  });
  container = document.createElement("div");
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  editor.destroy();
  // DocumentSync state is per-path and module-global.
  closeDocumentSync("/ws/note.md");
});

async function flushSaves() {
  // The save fires SAVE_DEBOUNCE_MS after the last edit; serialize + write
  // are promise-chained microtasks plus the inline codec. Wait past the
  // debounce, then let the loop drain.
  for (let i = 0; i < 40; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
    if (
      writeFileContentMock.mock.calls.length > 0 &&
      !editorHasPendingSave()
    ) {
      break;
    }
  }
}

function editorHasPendingSave(): boolean {
  const lastCall = writeFileContentMock.mock.calls.at(-1);
  return lastCall === undefined;
}

describe("save pipeline (inline fallback = worker-boot-failure path)", () => {
  it("saves an edit after the debounce window", async () => {
    await render(makeFile("start"));

    await act(async () => {
      editor.commands.insertContentAt(editor.state.doc.content.size - 1, " typed");
    });
    await flushSaves();

    expect(writeFileContentMock).toHaveBeenCalled();
    const [basePath, path, markdown] =
      writeFileContentMock.mock.calls.at(-1)!;
    expect(basePath).toBe("/ws");
    expect(path).toBe("/ws/note.md");
    expect(markdown).toBe("start typed");
  });

  it("coalesces a burst of edits and always persists the final state", async () => {
    await render(makeFile("start"));

    await act(async () => {
      for (let i = 0; i < 10; i++) {
        editor.commands.insertContentAt(editor.state.doc.content.size - 1, "x");
      }
    });
    await flushSaves();

    const calls = writeFileContentMock.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    // Backpressure coalescing: far fewer writes than edits.
    expect(calls.length).toBeLessThan(10);
    expect(calls.at(-1)![2]).toBe("start" + "x".repeat(10));
  });

  it("matches the standalone parse/serialize facade output", async () => {
    const doc = await parseMarkdown("# Title\n\nBody");
    const result = await serializeDoc(doc);
    expect(result.markdown).toBe("# Title\n\nBody");
    expect(result.hash).toBe(calculateContentHash("# Title\n\nBody"));
  });

  it("adopts an external change without writing it back", async () => {
    await render(makeFile("start"));

    await render(makeFile("external content"));
    // Adoption parses asynchronously.
    for (let i = 0; i < 20; i++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
      if (editor.state.doc.textContent === "external content") break;
    }

    expect(editor.state.doc.textContent).toBe("external content");
    expect(writeFileContentMock).not.toHaveBeenCalled();
  });

  it("persists edits still in the debounce window on tab close (MET-71 #3)", async () => {
    await render(makeFile("start"));

    // Edit, then close the tab immediately — well inside the 500ms autosave
    // debounce, so no save has shipped yet.
    await act(async () => {
      editor.commands.insertContentAt(
        editor.state.doc.content.size - 1,
        " last-second",
      );
    });

    // disposeEditor's exact order: flush while the editor is alive, destroy,
    // then close the sync. The flush's serialize+write is in flight when
    // close() runs; the old generation bump used to discard it.
    await act(async () => {
      flushDocumentSync("/ws/note.md");
      editor.destroy();
      closeDocumentSync("/ws/note.md");
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });

    expect(writeFileContentMock).toHaveBeenCalled();
    expect(writeFileContentMock.mock.calls.at(-1)![2]).toBe(
      "start last-second",
    );
  });

  it("does not save while updates are suppressed as not-loaded", async () => {
    editor.destroy();
    editor = new Editor({
      extensions: editorExtensions,
      content: "start",
      editable: true,
      autofocus: false,
    });

    await act(async () => {
      root.render(
        createElement(function NotLoaded({ file }: HarnessProps) {
          useEditorFileSync(editor, file, "/ws", false);
          return null;
        }, { file: makeFile("start") }),
      );
    });

    await act(async () => {
      editor.commands.insertContentAt(editor.state.doc.content.size - 1, "!");
    });
    // Wait well past the save debounce before asserting nothing was written.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 700));
    });

    expect(writeFileContentMock).not.toHaveBeenCalled();
  });
});
