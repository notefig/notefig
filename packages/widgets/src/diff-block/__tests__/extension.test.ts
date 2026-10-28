import { describe, it, expect, afterEach } from "vitest";
import { Editor, Extension } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import { codeDiff } from "../extension";
import { DiffCodeBlock } from "../schema";
import type { DiffBlockElement } from "../element";
import { captureSelectionReference } from "../../prompt/doc-helpers";

let editor: Editor | null = null;
afterEach(() => {
  editor?.view.dom.parentElement?.remove();
  editor?.destroy();
  editor = null;
});

const DIFF =
  '<pre><code class="language-ts" data-diff="">--- a.ts\n+++ a.ts\n@@ -1 +1 @@\n-const a = 1;\n+const a = 2;</code></pre>';

function mount(content: string) {
  editor = new Editor({
    // On the page: a diff draws once it is.
    element: document.body.appendChild(document.createElement("div")),
    extensions: [
      StarterKit.configure({ codeBlock: false }),
      DiffCodeBlock,
      Extension.create({ name: "codeDiff", addProseMirrorPlugins: () => [codeDiff()] }),
    ],
    content,
  });
  return editor;
}

const diffs = () => editor!.view.dom.querySelectorAll("notefig-diff-block");
/** The code blocks' own, not the ones the diffs hold. */
const pres = () => [...editor!.view.dom.querySelectorAll(":scope > pre")] as HTMLElement[];
const hidden = (pre: HTMLElement) => pre.style.display === "none";

/** The position of the first code block. */
function codeBlockAt(): number {
  let at = -1;
  editor!.state.doc.descendants((node, pos) => {
    if (at === -1 && node.type.name === "codeBlock") at = pos;
    return at === -1;
  });
  return at;
}

function select(anchor: number, head = anchor) {
  const { state, view } = editor!;
  view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, anchor, head)));
}

function press(key: string) {
  editor!.view.dom.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
}

const selected = () => diffs()[0].hasAttribute("data-selected");
const keysOn = () => (diffs()[0] as DiffBlockElement).keys;
const blockSelected = () => {
  const { selection } = editor!.state;
  return selection instanceof NodeSelection && selection.from === codeBlockAt();
};

describe("codeDiff", () => {
  it("draws a diff block as its card in place of its source", async () => {
    mount(`<p>Before</p>${DIFF}`);
    expect(diffs()).toHaveLength(1);
    expect(hidden(pres()[0])).toBe(true);
    const lines = () => [
      ...(diffs()[0].querySelector("diffs-container")?.shadowRoot?.querySelectorAll("[data-line-type]:not([data-column-number])") ?? []),
    ];
    await expect
      .poll(() => lines().map((line) => line.getAttribute("data-line-type")))
      .toEqual(["change-deletion", "change-addition"]);
  });

  it("selects the block a caret would land in, and wears the tint", () => {
    mount(`<p>Before</p>${DIFF}<p>After</p>`);
    select(codeBlockAt() + 3);
    expect(blockSelected()).toBe(true);
    expect(selected()).toBe(true);
    expect(diffs()).toHaveLength(1);
    select(1);
    expect(selected()).toBe(false);
  });

  it("grows a selection that ends in a block to take the whole block in", () => {
    mount(`<p>Before</p>${DIFF}<p>After</p>`);
    const block = codeBlockAt();
    const end = block + editor!.state.doc.nodeAt(block)!.nodeSize;
    select(2, block + 4);
    expect(editor!.state.selection.to).toBe(end - 1);
    expect(selected()).toBe(true);
    // Backwards, from the line after.
    select(end + 2, block + 4);
    expect(editor!.state.selection.from).toBe(block + 1);
    expect(selected()).toBe(true);
  });

  it("references a selected block whole, or a range taking it in", () => {
    mount(`<p>Before</p>${DIFF}<p>After</p>`);
    select(codeBlockAt() + 1);
    expect(captureSelectionReference(editor!.state)?.text).toBe(editor!.state.doc.nodeAt(codeBlockAt())!.textContent);
    select(2, codeBlockAt() + 4);
    expect(captureSelectionReference(editor!.state)?.text).toMatch(/^efore\n--- a\.ts[^]*\+const a = 2;$/);
  });

  it("puts the keys on the block selected alone: a digit runs its control", async () => {
    mount(`<p>Before</p>${DIFF}<p>After</p>`);
    await Promise.resolve(); // drawn
    select(codeBlockAt() + 1);
    expect(keysOn()).toBe(true);
    press("1");
    expect(diffs()).toHaveLength(0);
    expect(hidden(pres()[0])).toBe(false);

    // A range through it tints it, but the keys stay with the text.
    select(2, codeBlockAt() + 4);
    expect(selected()).toBe(true);
    expect(keysOn()).toBe(false);
  });

  it("edits the selected block on Enter, until Escape selects it again", () => {
    mount(`<p>Before</p>${DIFF}<p>After</p>`);
    const drawn = diffs()[0];
    select(codeBlockAt() + 1);
    press("Enter");
    expect(diffs()).toHaveLength(0);
    expect(hidden(pres()[0])).toBe(false);
    expect(editor!.state.selection.from).toBe(codeBlockAt() + 1);

    // An edit in the source redraws nothing while it is shown.
    editor!.commands.insertContent("x");
    expect(diffs()).toHaveLength(0);

    press("Escape");
    expect(blockSelected()).toBe(true);
    expect(diffs()).toHaveLength(1);
    expect(diffs()[0]).not.toBe(drawn);
  });

  it("leaves editing when the selection leaves the block", () => {
    mount(`<p>Before</p>${DIFF}`);
    (diffs()[0] as DiffBlockElement).onEdit!();
    expect(diffs()).toHaveLength(0);
    select(1);
    expect(diffs()).toHaveLength(1);
    expect(hidden(pres()[0])).toBe(true);
  });

  it("draws a diff the document opens with the caret in", () => {
    mount(DIFF);
    expect(diffs()).toHaveLength(1);
    editor!.commands.setContent(`${DIFF}<p>After</p>`);
    expect(diffs()).toHaveLength(1);
  });

  it("keeps a diff drawn through edits elsewhere", () => {
    mount(`<p>Before</p>${DIFF}`);
    const drawn = diffs()[0];
    select(2);
    editor!.commands.insertContent("x");
    expect(diffs()[0]).toBe(drawn);
  });

  it("marks the document with the workspace its diffs' paths are in", () => {
    editor = new Editor({
      element: document.body.appendChild(document.createElement("div")),
      extensions: [
        StarterKit.configure({ codeBlock: false }),
        DiffCodeBlock,
        Extension.create({ name: "codeDiff", addProseMirrorPlugins: () => [codeDiff({ workspacePath: "/ws" })] }),
      ],
      content: DIFF,
    });
    expect(editor.view.dom.getAttribute("data-workspace-path")).toBe("/ws");
    expect(editor.view.dom.getAttribute("role")).toBe("textbox");
  });

  it("offers editing only where the editor is editable", () => {
    mount(`<p>Before</p>${DIFF}`);
    expect((diffs()[0] as DiffBlockElement).onEdit).toBeTypeOf("function");
    editor!.destroy();
    editor = new Editor({
      element: document.body.appendChild(document.createElement("div")),
      extensions: [
        StarterKit.configure({ codeBlock: false }),
        DiffCodeBlock,
        Extension.create({ name: "codeDiff", addProseMirrorPlugins: () => [codeDiff()] }),
      ],
      content: `<p>Before</p>${DIFF}`,
      editable: false,
    });
    expect((diffs()[0] as DiffBlockElement).onEdit).toBeUndefined();
  });

  it("leaves other code blocks, and a diff block with no hunks, as code", () => {
    mount(
      '<pre><code class="language-ts">--- a.ts\n+++ a.ts\n@@ -1 +1 @@\n-a\n+b</code></pre>' +
        '<pre><code class="language-ts" data-diff="">-a\n+b</code></pre>',
    );
    expect(diffs()).toHaveLength(0);
    expect(pres().some(hidden)).toBe(false);
  });
});
