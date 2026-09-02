/**
 * The aiPrompt document node: UI-only (serializes to nothing), kept present
 * in empty documents by the keeper, and summonable with "/" in empty
 * top-level paragraphs.
 *
 * The widget itself lives in @notefig/widgets; this exercises it inside the
 * app's real editor kit and markdown codec, which is why it stays here.
 */
import { describe, it, expect, afterEach } from "vitest";
import { Editor } from "@tiptap/core";
import { editorExtensions } from "@/components/editor/tiptap-editor-kit";
import { widgetRendererNodes } from "@notefig/widgets";
import { removeToParagraphTr, revertToSlashTr } from "@notefig/widgets";
import { createMarkdownCodec } from "@/components/editor/markdown-codec";
import { getEditorMarkdown } from "@/components/editor/use-editor-file-sync";
import { selectionDraft } from "@notefig/widgets";

/** The editor's create hook (where the keeper's initial insert runs) fires
 *  asynchronously — construction alone isn't enough for assertions. */
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
    // The keeper's actual shape: widget first, empty paragraph below.
    expect(
      codec.serialize({
        type: "doc",
        content: [{ type: "aiPrompt" }, { type: "paragraph" }],
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

  it("sits first in the document — no blank line above the widget", async () => {
    editor = await documentEditor("");
    expect(editor.state.doc.firstChild?.type.name).toBe("aiPrompt");
    // The empty paragraph stays below as the caret landing spot.
    expect(editor.state.doc.lastChild?.type.name).toBe("paragraph");
  });

  it("puts the caret in the fresh keeper's draft on create", async () => {
    editor = await documentEditor("");
    const keeper = findPromptNode(editor);
    expect(keeper?.blobId).toBeTruthy();
    expect(selectionDraft(editor.state)?.blobId).toBe(keeper!.blobId);
  });

  it("does not touch documents that open with content", async () => {
    editor = await documentEditor("<p>Hi there</p>");
    expect(hasPromptNode(editor)).toBe(false);
  });

  it("treats a frontmatter-only document as empty and inserts below the frontmatter (MET-137)", async () => {
    editor = await documentEditor("---\ntitle: x\n---");
    expect(hasPromptNode(editor)).toBe(true);
    expect(editor.state.doc.child(0).type.name).toBe("frontmatter");
    expect(editor.state.doc.child(1).type.name).toBe("aiPrompt");
    expect(getEditorMarkdown(editor)).toBe("---\ntitle: x\n---");
  });

  it("frontmatter plus body counts as real content — no widget", async () => {
    editor = await documentEditor("---\ntitle: x\n---\n\nBody");
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

  it("reinserts first without stealing focus when the doc becomes empty", async () => {
    editor = await documentEditor("<p>Some text</p>");
    editor.commands.clearContent(true);
    expect(editor.state.doc.firstChild?.type.name).toBe("aiPrompt");
    // The user's cursor stays where it was: the reinsert must not move it
    // into the draft (contrast with the on-create keeper).
    const keeper = findPromptNode(editor);
    expect(selectionDraft(editor.state)).toBeNull();
    // Selection remains in the paragraph below the widget.
    const { from } = editor.state.selection;
    expect(from).toBeGreaterThan(keeper!.pos);
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

type FoundPromptNode = {
  pos: number;
  summoned: boolean;
  nodeSize: number;
  blobId: string | null;
};

function findPromptNodes(target: Editor): FoundPromptNode[] {
  const found: FoundPromptNode[] = [];
  target.state.doc.descendants((node, pos) => {
    if (node.type.name === "aiPrompt") {
      found.push({
        pos,
        summoned: Boolean(node.attrs.summoned),
        nodeSize: node.nodeSize,
        blobId: (node.attrs.blobId as string | null) ?? null,
      });
    }
  });
  return found;
}

function findPromptNode(target: Editor): FoundPromptNode | null {
  return findPromptNodes(target)[0] ?? null;
}

describe('"/" summon', () => {
  it("replaces an empty top-level paragraph with a summoned widget", async () => {
    editor = await documentEditor("<p>Hi there</p><p></p>");
    editor.commands.setTextSelection(11); // inside the empty paragraph
    expect(typeText(editor, "/")).toBe(true);
    const node = findPromptNode(editor);
    expect(node?.summoned).toBe(true);
    expect(node?.blobId).toBeTruthy();
    expect(getEditorMarkdown(editor)).toBe("Hi there");
    // The caret moved into the new widget's draft, in the same transaction.
    expect(selectionDraft(editor.state)?.blobId).toBe(node!.blobId);
  });

  it("types normally mid-text", async () => {
    editor = await documentEditor("<p>Hi there</p>");
    editor.commands.setTextSelection(3);
    expect(typeText(editor, "/")).toBe(false);
    expect(findPromptNode(editor)).toBeNull();
  });

  it("summons inside an empty list item without changing the markdown", async () => {
    // The doc needs real content — a lone empty list counts as "empty",
    // where the keeper widget exists and "/" routes to focusing it.
    editor = await documentEditor("<p>Hi</p><ul><li><p></p></li></ul>");
    const markdownBefore = getEditorMarkdown(editor);
    editor.commands.setTextSelection(7); // empty list paragraph
    expect(typeText(editor, "/")).toBe(true);
    const node = findPromptNode(editor);
    expect(node?.summoned).toBe(true);
    // The widget replaced the item's paragraph in place — list intact,
    // serialized file identical.
    expect(getEditorMarkdown(editor)).toBe(markdownBefore);
    expect(selectionDraft(editor.state)?.blobId).toBe(node!.blobId);
  });

  it("summons inside an indented (nested) list item", async () => {
    editor = await documentEditor(
      "<p>Hi</p><ul><li><p>a</p><ul><li><p></p></li></ul></li></ul>",
    );
    editor.commands.setTextSelection(12); // empty paragraph in the nested item
    expect(typeText(editor, "/")).toBe(true);
    expect(findPromptNode(editor)?.summoned).toBe(true);
  });

  it("undo restores the empty list item after a summon", async () => {
    editor = await documentEditor("<p>Hi</p><ul><li><p></p></li></ul>");
    const markdownBefore = getEditorMarkdown(editor);
    editor.commands.setTextSelection(7);
    typeText(editor, "/");
    editor.commands.undo();
    expect(findPromptNode(editor)).toBeNull();
    expect(getEditorMarkdown(editor)).toBe(markdownBefore);
    expect(editor.state.selection.from).toBe(7);
  });

  it("reverts to a literal '/' inside the list item", async () => {
    editor = await documentEditor("<p>Hi</p><ul><li><p></p></li></ul>");
    editor.commands.setTextSelection(7);
    typeText(editor, "/");
    const node = findPromptNode(editor)!;
    editor.view.dispatch(
      revertToSlashTr(editor.state, node.pos, node.nodeSize),
    );
    expect(findPromptNode(editor)).toBeNull();
    expect(getEditorMarkdown(editor)).toBe("Hi\n\n- /");
    expect(editor.state.selection.from).toBe(node.pos + 2);
  });

  it("summons inside an empty ordered-list item", async () => {
    editor = await documentEditor("<p>Hi</p><ol><li><p></p></li></ol>");
    editor.commands.setTextSelection(7); // empty ordered-list paragraph
    expect(typeText(editor, "/")).toBe(true);
    expect(findPromptNode(editor)?.summoned).toBe(true);
  });

  it("summons inside an empty task item without changing the markdown", async () => {
    editor = await documentEditor(
      '<p>Hi</p><ul data-type="taskList"><li data-type="taskItem"><p></p></li></ul>',
    );
    const markdownBefore = getEditorMarkdown(editor);
    editor.commands.setTextSelection(7); // empty paragraph in the task item
    expect(typeText(editor, "/")).toBe(true);
    expect(findPromptNode(editor)?.summoned).toBe(true);
    expect(getEditorMarkdown(editor)).toBe(markdownBefore);
  });

  it("types normally inside code blocks and blockquotes", async () => {
    editor = await documentEditor("<pre><code>x</code></pre>");
    editor.commands.setTextSelection(2);
    expect(typeText(editor, "/")).toBe(false);
    expect(findPromptNode(editor)).toBeNull();

    editor.destroy();
    editor = await documentEditor("<p>Hi</p><blockquote><p></p></blockquote>");
    editor.commands.setTextSelection(6); // empty paragraph in the blockquote
    expect(typeText(editor, "/")).toBe(false);
    expect(findPromptNode(editor)).toBeNull();
  });

  it("moves the caret to the keeper in an empty doc instead of inserting twice", async () => {
    editor = await documentEditor("");
    const keeper = findPromptNode(editor);
    expect(keeper?.blobId).toBeTruthy();
    // Out of the draft first, so the assertion below proves the "/" itself
    // put the caret back rather than the on-create keeper having left it.
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    expect(selectionDraft(editor.state)).toBeNull();
    expect(typeText(editor, "/")).toBe(true);
    expect(findPromptNodes(editor)).toHaveLength(1);
    expect(selectionDraft(editor.state)?.blobId).toBe(keeper!.blobId);
  });

  it("gives each summoned widget its own instance id", async () => {
    editor = await documentEditor("<p>Hi</p><p></p><p>there</p><p></p>");
    // First empty paragraph: after "Hi" (0..4).
    editor.commands.setTextSelection(5);
    expect(typeText(editor, "/")).toBe(true);
    // Second empty paragraph, now at the end.
    const last = editor.state.doc.content.size - 1;
    editor.commands.setTextSelection(last);
    expect(typeText(editor, "/")).toBe(true);

    const nodes = findPromptNodes(editor);
    expect(nodes).toHaveLength(2);
    expect(nodes[0].blobId).toBeTruthy();
    expect(nodes[1].blobId).toBeTruthy();
    expect(nodes[0].blobId).not.toBe(nodes[1].blobId);
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
    // Regression: the cursor must land back where "/" was typed, not reset
    // to the start of the doc.
    expect(editor.state.selection.from).toBe(11);
  });

  it("Backspace-dismiss removes the widget with no literal '/' left behind", async () => {
    editor = await documentEditor("<p>Hi there</p><p></p>");
    editor.commands.setTextSelection(11);
    typeText(editor, "/");
    const node = findPromptNode(editor)!;
    editor.view.dispatch(
      removeToParagraphTr(editor.state, node.pos, node.nodeSize),
    );
    expect(findPromptNode(editor)).toBeNull();
    // Contrast with revertToSlashTr's "Hi there\n\n/" — no slash survives.
    expect(getEditorMarkdown(editor)).toBe("Hi there");
    expect(editor.state.selection.from).toBe(node.pos + 1);
  });

  it("undo restores the widget after a Backspace-dismiss", async () => {
    editor = await documentEditor("<p>Hi there</p><p></p>");
    editor.commands.setTextSelection(11);
    typeText(editor, "/");
    const node = findPromptNode(editor)!;
    // History groups transactions dispatched within its newGroupDelay
    // (500ms) into a single undo step — a real delay keeps summon and
    // dismiss as separate steps, matching how a user actually interacts.
    await new Promise((resolve) => setTimeout(resolve, 600));
    editor.view.dispatch(
      removeToParagraphTr(editor.state, node.pos, node.nodeSize),
    );
    expect(findPromptNode(editor)).toBeNull();
    editor.commands.undo();
    expect(findPromptNode(editor)?.blobId).toBe(node.blobId);
  });
});
