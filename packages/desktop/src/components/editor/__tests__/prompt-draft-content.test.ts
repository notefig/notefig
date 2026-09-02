/**
 * The prompt widget's draft as document content.
 *
 * Moving the composer out of a nested editor and into the document is what
 * lets the caret in a prompt be an ordinary ProseMirror selection — which is
 * what makes the tab layout's selection memory, the viewport memory and the
 * focus arbiter reach it without knowing widgets exist. Everything below is
 * a property that move had to preserve, and the two it had to establish:
 * the draft must never reach the file, and it must never trigger a save.
 */
import { describe, it, expect, afterEach } from "vitest";
import { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { editorExtensions } from "../tiptap-editor-kit";
import {
  docHasRealContent,
  promptDraftRange,
  selectionDraft,
  widgetRendererNodes,
} from "@notefig/widgets";
import { createMarkdownCodec } from "../markdown-codec";
import { carryDraftsForward, isDraftOnlyEdit } from "../draft-only-edit";

const MARKER = '<!-- notefig:prompt id="blob_1a2b" task="task_9f8e" -->';

let editor: Editor | null = null;

/** An editor with the widget armed for a real document path. onCreate (the
 *  keeper's insert) is async, so callers await a macrotask. */
async function documentEditor(content: string): Promise<Editor> {
  const created = new Editor({
    extensions: [
      ...editorExtensions.filter((e) => e.name !== "aiPrompt"),
      ...widgetRendererNodes({ filePath: "/ws/doc.md", basePath: "/ws" }),
    ],
    content,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  return created;
}

function markdownOf(target: Editor): string {
  return (
    target.storage as unknown as { markdown: { getMarkdown(): string } }
  ).markdown.getMarkdown();
}

/** Type `text` into the widget's draft, as the user would. */
function typeIntoDraft(target: Editor, blobId: string, text: string): void {
  const range = promptDraftRange(target.state.doc, blobId);
  if (!range) throw new Error(`no draft for ${blobId}`);
  target.view.dispatch(
    target.state.tr.setSelection(TextSelection.create(target.state.doc, range.to)),
  );
  target.view.dispatch(target.state.tr.insertText(text));
}

function firstBlobId(target: Editor): string {
  let id: string | null = null;
  target.state.doc.descendants((node) => {
    if (id === null && node.type.name === "aiPrompt") {
      id = node.attrs.blobId as string;
    }
    return id === null;
  });
  if (!id) throw new Error("no widget in the document");
  return id;
}

afterEach(() => {
  editor?.destroy();
  editor = null;
});

describe("a draft is document content", () => {
  it("gives every widget a draft child to type into", async () => {
    editor = await documentEditor(`Before\n\n${MARKER}\n\nAfter\n`);
    const range = promptDraftRange(editor.state.doc, "blob_1a2b");
    expect(range).not.toBeNull();
    expect(range!.node.type.name).toBe("promptDraft");
  });

  it("puts the caret in the draft, as an ordinary text selection", async () => {
    editor = await documentEditor(`Before\n\n${MARKER}\n\nAfter\n`);
    const range = promptDraftRange(editor.state.doc, "blob_1a2b")!;
    editor.commands.setTextSelection(range.to);
    // The whole point: no widget-shaped focus state anywhere — the document
    // selection IS the caret, so saving and restoring it restores the
    // composer for free.
    expect(editor.state.selection.empty).toBe(true);
    expect(selectionDraft(editor.state)?.blobId).toBe("blob_1a2b");
  });
});

describe("the schema is what isolates a draft", () => {
  it("refuses the block conversions the document offers", async () => {
    editor = await documentEditor(`Before\n\n${MARKER}\n\nAfter\n`);
    const range = promptDraftRange(editor.state.doc, "blob_1a2b")!;
    editor.commands.setTextSelection(range.to);
    typeIntoDraft(editor, "blob_1a2b", "some prompt text");

    // The widget's content expression admits only `promptDraft`, so every
    // command that wants to retype the textblock fails `canReplaceWith` and
    // no-ops — no per-extension suppression anywhere.
    for (const run of [
      () => editor!.commands.toggleHeading({ level: 1 }),
      () => editor!.commands.toggleBulletList(),
      () => editor!.commands.toggleBlockquote(),
      () => editor!.commands.toggleCodeBlock(),
      () => editor!.commands.splitBlock(),
    ]) {
      run();
      expect(promptDraftRange(editor.state.doc, "blob_1a2b")?.node.textContent).toBe(
        "some prompt text",
      );
    }
  });

  it("refuses every mark, so the toolbar and input rules are inert in it", async () => {
    editor = await documentEditor(`Before\n\n${MARKER}\n\nAfter\n`);
    typeIntoDraft(editor, "blob_1a2b", "some prompt text");
    const range = promptDraftRange(editor.state.doc, "blob_1a2b")!;
    editor.commands.setTextSelection({ from: range.from, to: range.to });

    editor.commands.toggleBold();
    editor.commands.toggleItalic();
    editor.commands.toggleCode();

    // `marks: ""` on the draft node: the commands run, the mark is not
    // admissible, nothing lands.
    const draft = promptDraftRange(editor.state.doc, "blob_1a2b")!.node;
    draft.descendants((node) => {
      expect(node.marks).toHaveLength(0);
      return true;
    });
  });
});

describe("a draft never reaches the file", () => {
  it("serializes to the marker alone, whatever is typed in it", async () => {
    editor = await documentEditor(`Before\n\n${MARKER}\n\nAfter\n`);
    const before = markdownOf(editor);
    typeIntoDraft(editor, "blob_1a2b", "rewrite this paragraph please");
    expect(markdownOf(editor)).toBe(before);
    expect(markdownOf(editor)).toContain(MARKER);
  });

  it("leaves an unbound widget's draft out of the file entirely", async () => {
    editor = await documentEditor("");
    typeIntoDraft(editor, firstBlobId(editor), "a half-written prompt");
    // An untouched document stays byte-identical on disk: an unbound widget
    // serializes to nothing, and so does everything in it.
    expect(markdownOf(editor).trim()).toBe("");
  });

  it("agrees with the worker codec, which never sees a draft", async () => {
    editor = await documentEditor(`Before\n\n${MARKER}\n\nAfter\n`);
    typeIntoDraft(editor, "blob_1a2b", "typing");
    expect(createMarkdownCodec().serialize(editor.state.doc.toJSON())).toBe(
      markdownOf(editor),
    );
  });

  it("keeps a document holding only a draft 'empty'", async () => {
    editor = await documentEditor("");
    typeIntoDraft(editor, firstBlobId(editor), "not the document's content");
    // The keeper, the "/" summon and the dismiss semantics all hang off
    // this: a draft is the user's half-written prompt, not the file's text.
    expect(docHasRealContent(editor.state.doc)).toBe(false);
  });
});

describe("a draft never triggers a save", () => {
  it("reports draft typing as a draft-only edit", async () => {
    editor = await documentEditor(`Before\n\n${MARKER}\n\nAfter\n`);
    const seen: boolean[] = [];
    editor.on("update", ({ transaction }) =>
      seen.push(isDraftOnlyEdit(transaction)),
    );
    typeIntoDraft(editor, "blob_1a2b", "hello");
    expect(seen).not.toHaveLength(0);
    expect(seen.every(Boolean)).toBe(true);
  });

  it("still reports ordinary prose edits as saveable", async () => {
    editor = await documentEditor(`Before\n\n${MARKER}\n\nAfter\n`);
    const seen: boolean[] = [];
    editor.on("update", ({ transaction }) =>
      seen.push(isDraftOnlyEdit(transaction)),
    );
    editor.commands.setTextSelection(3);
    editor.commands.insertContent("X");
    expect(seen).not.toHaveLength(0);
    expect(seen.some(Boolean)).toBe(false);
  });
});

describe("adoption carries drafts forward", () => {
  it("keeps a half-typed prompt when an agent rewrites the file", async () => {
    editor = await documentEditor(`Before\n\n${MARKER}\n\nAfter\n`);
    typeIntoDraft(editor, "blob_1a2b", "mid-sentence");

    // What the sync layer hands setContent: the file re-parsed, with the
    // widget back from its marker and its draft — which is not on disk —
    // empty.
    const incoming = createMarkdownCodec().parse(
      `Before\n\n${MARKER}\n\nAfter, rewritten by the agent\n`,
    );
    const merged = carryDraftsForward(incoming, editor.state.doc);

    editor.commands.setContent(merged, { emitUpdate: false });
    const range = promptDraftRange(editor.state.doc, "blob_1a2b")!;
    expect(range.node.textContent).toBe("mid-sentence");
    expect(markdownOf(editor)).toContain("rewritten by the agent");
  });

  it("drops the draft of a widget the write removed", async () => {
    editor = await documentEditor(`Before\n\n${MARKER}\n\nAfter\n`);
    typeIntoDraft(editor, "blob_1a2b", "mid-sentence");

    const incoming = createMarkdownCodec().parse("Before\n\nAfter\n");
    const merged = carryDraftsForward(incoming, editor.state.doc);

    editor.commands.setContent(merged, { emitUpdate: false });
    expect(promptDraftRange(editor.state.doc, "blob_1a2b")).toBeNull();
  });
});
