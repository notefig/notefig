import { describe, it, expect, vi, beforeEach } from "vitest";
import { Editor } from "@tiptap/core";
import type { EditorView } from "@tiptap/pm/view";
import { editorExtensions } from "@/components/editor/tiptap-editor-kit";
import {
  createImageDropHandler,
  createImagePasteHandler,
} from "@/components/editor/editor-image-paste";
import { platformAdapter } from "@/adapters";

vi.mock("@/adapters", async () => ({
  platformAdapter: {
    db: (await import("@/testing/node-db")).createNodeTestDb(),
    fs: {
      exists: vi.fn(),
      writeBinaryFiles: vi.fn(),
    },
  },
}));

const existsMock = vi.mocked(platformAdapter.fs.exists);
const writeMock = vi.mocked(platformAdapter.fs.writeBinaryFiles);

const BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

function createEditor(content = "Hello world") {
  return new Editor({ extensions: editorExtensions, content });
}

/** Minimal PM view stub: live state from the editor, dispatch through it. */
function stubView(editor: Editor): EditorView {
  return {
    get state() {
      return editor.state;
    },
    dispatch: (tr: unknown) => editor.view.dispatch(tr as never),
    posAtCoords: () => null,
  } as unknown as EditorView;
}

function makeImageFile(name = "photo.png", type = "image/png"): File {
  return new File([BYTES], name, { type });
}

function dropEvent(files: File[]): DragEvent {
  return {
    preventDefault: vi.fn(),
    clientX: 0,
    clientY: 0,
    dataTransfer: { files },
  } as unknown as DragEvent;
}

function pasteEvent(file: File | null, type = "image/png"): ClipboardEvent {
  return {
    preventDefault: vi.fn(),
    clipboardData: {
      items: [{ type, getAsFile: () => file }],
    },
  } as unknown as ClipboardEvent;
}

function findImageSrcs(editor: Editor): string[] {
  const srcs: string[] = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name === "image") srcs.push(node.attrs.src as string);
  });
  return srcs;
}

beforeEach(() => {
  existsMock.mockReset();
  writeMock.mockReset();
  existsMock.mockImplementation(async (paths: string[]) =>
    paths.map((path) => ({ path, exists: false })),
  );
  writeMock.mockResolvedValue({ succeeded: [], failed: [] });
});

describe("createImageDropHandler", () => {
  it("writes the image bytes to assets/ and inserts a node with a relative src", async () => {
    const editor = createEditor();
    const handler = createImageDropHandler("/ws");
    const event = dropEvent([makeImageFile("photo (1).png")]);

    const handled = handler(stubView(editor), event, null, false);

    expect(handled).toBe(true);
    expect(event.preventDefault).toHaveBeenCalled();

    await vi.waitFor(() => {
      expect(writeMock).toHaveBeenCalledTimes(1);
    });

    const [written] = writeMock.mock.calls[0][0];
    expect(written.path).toBe("/ws/assets/photo-1.png");
    expect(Array.from(written.data)).toEqual(Array.from(BYTES));
    expect(findImageSrcs(editor)).toEqual(["assets/photo-1.png"]);
    editor.destroy();
  });

  it("dedupes against existing asset names", async () => {
    const editor = createEditor();
    existsMock.mockImplementation(async (paths: string[]) =>
      paths.map((path) => ({
        path,
        exists: path === "/ws/assets/photo.png",
      })),
    );

    const handler = createImageDropHandler("/ws");
    handler(
      stubView(editor),
      dropEvent([makeImageFile("photo.png")]),
      null,
      false,
    );

    await vi.waitFor(() => {
      expect(writeMock).toHaveBeenCalledTimes(1);
    });
    expect(writeMock.mock.calls[0][0][0].path).toBe("/ws/assets/photo-1.png");
    editor.destroy();
  });

  it("lets ProseMirror handle internal node moves", () => {
    const editor = createEditor();
    const handler = createImageDropHandler("/ws");
    const event = dropEvent([makeImageFile()]);

    expect(handler(stubView(editor), event, null, true)).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(writeMock).not.toHaveBeenCalled();
    editor.destroy();
  });

  it("ignores drops without image files", () => {
    const editor = createEditor();
    const handler = createImageDropHandler("/ws");
    const event = dropEvent([makeImageFile("notes.txt", "text/plain")]);

    expect(handler(stubView(editor), event, null, false)).toBe(false);
    expect(writeMock).not.toHaveBeenCalled();
    editor.destroy();
  });

  it("ignores drops with no files at all", () => {
    const editor = createEditor();
    const handler = createImageDropHandler("/ws");

    expect(handler(stubView(editor), dropEvent([]), null, false)).toBe(false);
    editor.destroy();
  });
});

describe("createImagePasteHandler", () => {
  it("writes a pasted image and inserts it at the selection", async () => {
    const editor = createEditor();
    const handler = createImagePasteHandler("/ws");
    const event = pasteEvent(makeImageFile("ignored-name.png"));

    expect(handler(stubView(editor), event)).toBe(true);
    expect(event.preventDefault).toHaveBeenCalled();

    await vi.waitFor(() => {
      expect(writeMock).toHaveBeenCalledTimes(1);
    });

    const [written] = writeMock.mock.calls[0][0];
    expect(written.path).toMatch(/^\/ws\/assets\/pasted-\d+\.png$/);
    expect(Array.from(written.data)).toEqual(Array.from(BYTES));
    expect(findImageSrcs(editor)).toHaveLength(1);
    expect(findImageSrcs(editor)[0]).toMatch(/^assets\/pasted-\d+\.png$/);
    editor.destroy();
  });

  it("ignores non-image clipboard items", () => {
    const editor = createEditor();
    const handler = createImagePasteHandler("/ws");
    const event = pasteEvent(null, "text/plain");

    expect(handler(stubView(editor), event)).toBe(false);
    expect(writeMock).not.toHaveBeenCalled();
    editor.destroy();
  });
});
