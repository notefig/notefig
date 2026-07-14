/**
 * The aiPrompt document node: UI-only (serializes to nothing), kept present
 * in empty documents by the keeper, and summonable with "/" in empty
 * top-level paragraphs (ai-prompt-node.tsx).
 */
import { describe, it, expect, afterEach } from "vitest";
import { Editor } from "@tiptap/core";
import { editorExtensions } from "@/components/editor/tiptap-editor-kit";
import { AiPromptNode } from "@/components/editor/ai-prompt-node";
import { revertToSlashTr } from "@/components/editor/ai-prompt-utils";
import { createMarkdownCodec } from "@/components/editor/markdown-codec";
import { getEditorMarkdown } from "@/components/editor/use-editor-file-sync";
import { consumePendingPromptBlobFocus } from "@/components/agent/prompt-blob-store";

/** The editor's create hook (where the keeper's initial insert runs) fires
 *  asynchronously — construction alone isn't enough for assertions. */
async function documentEditor(content: string): Promise<Editor> {
  const created = new Editor({
    extensions: [
      ...editorExtensions.filter((e) => e.name !== "aiPrompt"),
      AiPromptNode.configure({ filePath: "/ws/doc.md", basePath: "/ws" }),
    ],
    content,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  return created;
}

function hasPromptNode(editor: Editor): boolean {
  let found = false;
  editor.state.doc.descendants((node) => {
    if (node.type.name === "aiPrompt") found = true;
    return !found;
  });
  return found;
}

let editor: Editor | null = null;
afterEach(() => {
  editor?.destroy();
  editor = null;
});

describe("aiPrompt markdown serialization", () => {
  it("serializes to nothing in the worker codec", () => {
    const codec = createMarkdownCodec();
    expect(
      codec.serialize({
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "Hello" }] },
          { type: "aiPrompt" },
        ],
      }),
    ).toBe("Hello");
    expect(
      codec.serialize({
        type: "doc",
        content: [{ type: "paragraph" }, { type: "aiPrompt" }],
      }),
    ).toBe("");
  });
});

describe("aiPrompt empty-document keeper", () => {
  it("inserts the node into an empty document on create", async () => {
    editor = await documentEditor("");
    expect(hasPromptNode(editor)).toBe(true);
    expect(getEditorMarkdown(editor)).toBe("");
  });

  it("does not touch documents that open with content", async () => {
    editor = await documentEditor("<p>Hi there</p>");
    expect(hasPromptNode(editor)).toBe(false);
  });

  it("survives typing and never leaks into the markdown", async () => {
    editor = await documentEditor("");
    editor.commands.insertContentAt(0, "Hello world");
    expect(hasPromptNode(editor)).toBe(true);
    expect(getEditorMarkdown(editor)).toBe("Hello world");
  });

  it("comes back when the document is emptied", async () => {
    editor = await documentEditor("<p>Some text</p>");
    expect(hasPromptNode(editor)).toBe(false);
    editor.commands.clearContent(true);
    expect(hasPromptNode(editor)).toBe(true);
  });

  it("stays disarmed on unconfigured (schema-only) instances", async () => {
    editor = new Editor({ extensions: editorExtensions, content: "" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(hasPromptNode(editor)).toBe(false);
  });
});

/** Feed one typed character through the view's handleTextInput props, the
 *  way ProseMirror would during real typing. */
function typeText(target: Editor, text: string): boolean {
  const { from, to } = target.state.selection;
  const defaultInsert = () => target.state.tr.insertText(text, from, to);
  return Boolean(
    target.view.someProp("handleTextInput", (handler) =>
      handler(target.view, from, to, text, defaultInsert),
    ),
  );
}

function findPromptNode(
  target: Editor,
): { pos: number; summoned: boolean; nodeSize: number } | null {
  let found: { pos: number; summoned: boolean; nodeSize: number } | null =
    null;
  target.state.doc.descendants((node, pos) => {
    if (node.type.name === "aiPrompt") {
      found = { pos, summoned: Boolean(node.attrs.summoned), nodeSize: node.nodeSize };
    }
    return found === null;
  });
  return found;
}

describe('"/" summon', () => {
  afterEach(() => {
    // Drain the one-shot focus channel between cases.
    consumePendingPromptBlobFocus("/ws/doc.md");
  });

  it("replaces an empty top-level paragraph with a summoned widget", async () => {
    editor = await documentEditor("<p>Hi there</p><p></p>");
    editor.commands.setTextSelection(11); // inside the empty paragraph
    expect(typeText(editor, "/")).toBe(true);
    const node = findPromptNode(editor);
    expect(node?.summoned).toBe(true);
    expect(getEditorMarkdown(editor)).toBe("Hi there");
    expect(consumePendingPromptBlobFocus("/ws/doc.md")).toBe(true);
  });

  it("types normally mid-text", async () => {
    editor = await documentEditor("<p>Hi there</p>");
    editor.commands.setTextSelection(3);
    expect(typeText(editor, "/")).toBe(false);
    expect(findPromptNode(editor)).toBeNull();
  });

  it("types normally inside nested paragraphs (lists) and code blocks", async () => {
    // The doc needs real content — a lone empty list counts as "empty",
    // where the keeper widget exists and "/" routes to focusing it.
    editor = await documentEditor("<p>Hi</p><ul><li><p></p></li></ul>");
    editor.commands.setTextSelection(7); // empty list paragraph, depth > 1
    expect(typeText(editor, "/")).toBe(false);
    expect(findPromptNode(editor)).toBeNull();

    editor.destroy();
    editor = await documentEditor("<pre><code>x</code></pre>");
    editor.commands.setTextSelection(2);
    expect(typeText(editor, "/")).toBe(false);
    expect(findPromptNode(editor)).toBeNull();
  });

  it("focuses the keeper widget in an empty doc instead of inserting twice", async () => {
    editor = await documentEditor("");
    expect(hasPromptNode(editor)).toBe(true);
    editor.commands.setTextSelection(1);
    expect(typeText(editor, "/")).toBe(true);
    let count = 0;
    editor.state.doc.descendants((node) => {
      if (node.type.name === "aiPrompt") count++;
    });
    expect(count).toBe(1);
    expect(consumePendingPromptBlobFocus("/ws/doc.md")).toBe(true);
  });

  it("reverts to a literal '/' with the cursor after it", async () => {
    editor = await documentEditor("<p>Hi there</p><p></p>");
    editor.commands.setTextSelection(11);
    typeText(editor, "/");
    const node = findPromptNode(editor)!;
    editor.view.dispatch(
      revertToSlashTr(editor.state, node.pos, node.nodeSize),
    );
    expect(findPromptNode(editor)).toBeNull();
    expect(getEditorMarkdown(editor)).toBe("Hi there\n\n/");
    expect(editor.state.selection.from).toBe(node.pos + 2);
  });

  it("undo restores the empty paragraph after a summon", async () => {
    editor = await documentEditor("<p>Hi there</p><p></p>");
    editor.commands.setTextSelection(11);
    typeText(editor, "/");
    expect(findPromptNode(editor)).not.toBeNull();
    editor.commands.undo();
    expect(findPromptNode(editor)).toBeNull();
    expect(getEditorMarkdown(editor)).toBe("Hi there");
  });
});
