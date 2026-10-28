import { describe, it, expect, afterEach } from "vitest";
import { Editor, Extension } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { TextSelection } from "@tiptap/pm/state";
import { codeDiff } from "../extension";

let editor: Editor | null = null;
afterEach(() => {
  editor?.destroy();
  editor = null;
});

const DIFF = '<pre><code class="language-diff:ts">const a = 1;\n=======\nconst a = 2;</code></pre>';

function mount(content: string) {
  editor = new Editor({
    extensions: [StarterKit, Extension.create({ name: "codeDiff", addProseMirrorPlugins: () => [codeDiff()] })],
    content,
  });
  return editor;
}

const diffs = () => editor!.view.dom.querySelectorAll(".diff-block diffs-container");
const pres = () => [...editor!.view.dom.querySelectorAll("pre")];
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

function select(pos: number) {
  const { state, view } = editor!;
  view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, pos)));
}

describe("codeDiff", () => {
  it("draws a diff block as its diff in place of its source", async () => {
    mount(`<p>Before</p>${DIFF}`);
    expect(diffs()).toHaveLength(1);
    expect(hidden(pres()[0])).toBe(true);
    // Drawn once the language loads; each line's number and its code.
    const lines = () => [...diffs()[0].shadowRoot!.querySelectorAll("[data-line-type]")];
    await expect
      .poll(() => lines().map((line) => line.getAttribute("data-line-type")))
      .toEqual(["change-deletion", "change-addition", "change-deletion", "change-addition"]);
  });

  it("shows the source while the selection is in it, and the diff again after", () => {
    mount(`<p>Before</p>${DIFF}`);
    const drawn = diffs()[0];
    select(codeBlockAt() + 1);
    expect(diffs()).toHaveLength(0);
    expect(hidden(pres()[0])).toBe(false);

    // An edit in the source redraws nothing while it is shown.
    editor!.commands.insertContent("x");
    expect(diffs()).toHaveLength(0);

    select(1);
    expect(diffs()).toHaveLength(1);
    expect(diffs()[0]).not.toBe(drawn);
    expect(hidden(pres()[0])).toBe(true);
  });

  it("draws a diff the document opens with the caret in", () => {
    mount(DIFF);
    expect(editor!.state.selection.$from.parent.type.name).toBe("codeBlock");
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

  it("puts the caret in the source on a click, where the editor is editable", () => {
    mount(`<p>Before</p>${DIFF}`);
    editor!.setEditable(false);
    (diffs()[0].parentElement as HTMLElement).click();
    expect(diffs()).toHaveLength(1);

    editor!.setEditable(true);
    (diffs()[0].parentElement as HTMLElement).click();
    expect(editor!.state.selection.from).toBe(codeBlockAt() + 1);
    expect(diffs()).toHaveLength(0);
  });

  it("leaves other code blocks, and a diff block with no separator, as code", () => {
    mount('<pre><code class="language-ts">const a = 1;</code></pre><pre><code class="language-diff:ts">const a = 1;</code></pre>');
    expect(diffs()).toHaveLength(0);
    expect(pres().some(hidden)).toBe(false);
  });
});
