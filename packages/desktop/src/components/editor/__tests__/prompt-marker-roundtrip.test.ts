/**
 * The persisted prompt widget (MET-163) through the real markdown pipeline:
 * a bound widget must survive file → doc → file byte-identically, and an
 * unbound one must still leave no trace at all.
 */
import { describe, it, expect } from "vitest";
import { Editor } from "@tiptap/core";
import { editorExtensions } from "../tiptap-editor-kit";
import { widgetRendererNodes } from "@notefig/widgets";
import { createMarkdownCodec } from "../markdown-codec";

const MARKER = '<!-- notefig:prompt id="blob_1a2b" task="task_9f8e" -->';

/** An editor with the widget armed for a real document path. */
function documentEditor(content: string) {
  return new Editor({
    extensions: [
      ...editorExtensions.filter((e) => e.name !== "aiPrompt"),
      ...widgetRendererNodes({ filePath: "/ws/doc.md", basePath: "/ws" }),
    ],
    content,
  });
}

function markdownOf(editor: Editor): string {
  return (
    editor.storage as unknown as { markdown: { getMarkdown(): string } }
  ).markdown.getMarkdown();
}

describe("prompt marker round trip", () => {
  it("parses a marker into a bound widget node", () => {
    const editor = documentEditor(`# Title\n\n${MARKER}\n\nAfter\n`);
    const widgets: Array<Record<string, unknown>> = [];
    editor.state.doc.descendants((node) => {
      if (node.type.name === "aiPrompt") widgets.push(node.attrs);
    });
    expect(widgets).toEqual([
      expect.objectContaining({ blobId: "blob_1a2b", taskId: "task_9f8e" }),
    ]);
    editor.destroy();
  });

  it("re-serializes the marker unchanged", () => {
    const source = `# Title\n\n${MARKER}\n\nAfter\n`;
    const editor = documentEditor(source);
    expect(markdownOf(editor)).toBe(source.trimEnd());
    editor.destroy();
  });

  it("keeps an unbound widget out of the file", async () => {
    // An empty document gets the keeper widget; it must serialize to nothing.
    // The keeper lands in the editor's async create hook.
    const editor = documentEditor("");
    await new Promise((resolve) => setTimeout(resolve, 0));
    let hasWidget = false;
    editor.state.doc.descendants((node) => {
      if (node.type.name === "aiPrompt") hasWidget = true;
    });
    expect(hasWidget).toBe(true);
    expect(markdownOf(editor).trim()).toBe("");
    editor.destroy();
  });

  it("writes the marker once a widget is bound", () => {
    const editor = documentEditor("Some content\n");
    editor.commands.insertContentAt(editor.state.doc.content.size, {
      type: "aiPrompt",
      attrs: { blobId: "blob_1a2b", taskId: "task_9f8e" },
    });
    expect(markdownOf(editor)).toContain(MARKER);
    editor.destroy();
  });

  it("agrees with the worker codec in both directions", () => {
    const source = `Before\n\n${MARKER}\n\nAfter`;
    const codec = createMarkdownCodec();
    const doc = codec.parse(source);
    expect(JSON.stringify(doc)).toContain("task_9f8e");
    expect(codec.serialize(doc)).toBe(source);
  });

  it("gives a marker-only file a caret landing spot", async () => {
    // Parsing just a marker yields a document whose only block is the atom —
    // nowhere to click. The repair must not reach the file.
    const editor = documentEditor(`${MARKER}\n`);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(editor.state.doc.lastChild?.type.name).toBe("paragraph");
    expect(editor.state.doc.firstChild?.type.name).toBe("aiPrompt");
    expect(markdownOf(editor)).toBe(MARKER);
    editor.destroy();
  });

  it("survives the adoption an agent write triggers", () => {
    // The ticket's bug: the agent rewrites the file mid-round, the editor
    // adopts the new markdown, and the widget vanished with the round.
    // Adoption is setContent over freshly parsed markdown.
    const editor = documentEditor(`${MARKER}\n`);
    const codec = createMarkdownCodec();
    const agentWrote = `# Written by the agent\n\n${MARKER}\n\nBody text\n`;
    editor.commands.setContent(codec.parse(agentWrote), {
      emitUpdate: false,
    });

    const widgets: Array<Record<string, unknown>> = [];
    editor.state.doc.descendants((node) => {
      if (node.type.name === "aiPrompt") widgets.push(node.attrs);
    });
    // Same instance id as before the write: the store record keyed by it
    // still holds this widget's running turn.
    expect(widgets).toEqual([
      expect.objectContaining({ blobId: "blob_1a2b", taskId: "task_9f8e" }),
    ]);
    editor.destroy();
  });

  it("leaves unrelated comments alone (they are still dropped today)", () => {
    // Not a promise to preserve them — just proof the marker rule is scoped
    // to our sentinel and does not start matching arbitrary comments.
    const codec = createMarkdownCodec();
    const doc = codec.parse("Before\n\n<!-- just a note -->\n\nAfter");
    expect(JSON.stringify(doc)).not.toContain("aiPrompt");
  });
});
