import { describe, it, expect, afterEach } from "vitest";
import { Editor, Extension } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { NodeSelection } from "@tiptap/pm/state";
import { drawnCodeBlocks } from "../../drawn-block/extension";
import { diffBlocks } from "../../diff-block/extension";
import { DiffCodeBlock } from "../../diff-block/schema";
import { mermaidBlocks } from "../extension";

let editor: Editor | null = null;
afterEach(() => {
  editor?.view.dom.parentElement?.remove();
  editor?.destroy();
  editor = null;
});

const MERMAID = '<pre><code class="language-mermaid">flowchart LR\n  A --&gt; B</code></pre>';
const DIFF =
  '<pre><code class="language-ts" data-diff="">--- a.ts\n+++ a.ts\n@@ -1 +1 @@\n-const a = 1;\n+const a = 2;</code></pre>';

function mount(content: string) {
  editor = new Editor({
    element: document.body.appendChild(document.createElement("div")),
    extensions: [
      StarterKit.configure({ codeBlock: false }),
      DiffCodeBlock,
      Extension.create({ name: "drawnCodeBlocks", addProseMirrorPlugins: () => [drawnCodeBlocks([diffBlocks(), mermaidBlocks])] }),
    ],
    content,
  });
  return editor;
}

const diagrams = () => editor!.view.dom.querySelectorAll("notefig-mermaid-block");
const diffs = () => editor!.view.dom.querySelectorAll("notefig-diff-block");

/** The positions of the document's code blocks. */
function codeBlocks(): number[] {
  const at: number[] = [];
  editor!.state.doc.descendants((node, pos) => {
    if (node.type.name === "codeBlock") at.push(pos);
  });
  return at;
}

function press(key: string) {
  editor!.view.dom.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
}

describe("mermaid blocks", () => {
  it("draws a diagram beside a diff, each its own card", async () => {
    mount(`<p>Before</p>${MERMAID}${DIFF}`);
    expect(diagrams()).toHaveLength(1);
    expect(diffs()).toHaveLength(1);
    await expect.poll(() => diagrams()[0].querySelector("svg")).not.toBeNull();
  });

  it("selects the diagram as one, edits it on Enter, and draws it again on Escape", () => {
    mount(`<p>Before</p>${MERMAID}<p>After</p>`);
    const [at] = codeBlocks();
    const { state, view } = editor!;
    view.dispatch(state.tr.setSelection(NodeSelection.create(state.doc, at)));
    expect(diagrams()[0].hasAttribute("data-selected")).toBe(true);
    press("Enter");
    expect(diagrams()).toHaveLength(0);
    editor!.commands.insertContent("C --> ");
    press("Escape");
    expect(diagrams()).toHaveLength(1);
    expect(diagrams()[0].textContent).toContain("C --> flowchart");
  });

  it("leaves an empty diagram as code, to be written", () => {
    mount('<pre><code class="language-mermaid"></code></pre>');
    expect(diagrams()).toHaveLength(0);
  });
});
