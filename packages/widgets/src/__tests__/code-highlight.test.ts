import { describe, it, expect, afterEach } from "vitest";
import { Editor, Extension } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { getSharedHighlighter } from "@pierre/diffs";
import { codeHighlight } from "../code-highlight";

let editor: Editor | null = null;
afterEach(() => editor?.destroy());

const coloured = () => editor!.view.dom.querySelectorAll("pre code span[style]").length;

/** Each coloured span's text and colour, in order. */
const colours = () =>
  Array.from(editor!.view.dom.querySelectorAll("pre code span[style]")).map(
    (span) => `${span.textContent}|${span.getAttribute("style")}`,
  );

function highlighted(content: string): Editor {
  editor = new Editor({
    extensions: [
      StarterKit,
      Extension.create({ name: "codeHighlight", addProseMirrorPlugins: () => [codeHighlight()] }),
    ],
    content,
  });
  return editor;
}

describe("codeHighlight", () => {
  it("leaves a block plain while the shared highlighter has its language but not the themes, then colours it", async () => {
    // Another user of the shared highlighter loaded the language alone.
    await getSharedHighlighter({ themes: [], langs: ["ts"] });

    editor = new Editor({
      extensions: [
        StarterKit,
        Extension.create({ name: "codeHighlight", addProseMirrorPlugins: () => [codeHighlight()] }),
      ],
      content: '<pre><code class="language-ts">const greeting = "hello";</code></pre>',
    });

    expect(coloured()).toBe(0);
    await expect.poll(coloured, { timeout: 10_000 }).toBeGreaterThan(0);
  });

  it("keeps each colour on its token through edits beside the block", async () => {
    await getSharedHighlighter({ themes: ["pierre-light", "pierre-dark"], langs: ["ts"] });
    const target = highlighted(
      '<p>Before</p><pre><code class="language-ts">const greeting = "hello";</code></pre><p>After</p>',
    );
    await expect.poll(coloured, { timeout: 10_000 }).toBeGreaterThan(0);
    const before = colours();

    target.chain().setTextSelection(3).insertContent("typed text").run();
    target.chain().setTextSelection(target.state.doc.content.size - 2).insertContent("more").run();
    target.chain().setTextSelection({ from: 1, to: 4 }).deleteSelection().run();

    expect(colours()).toEqual(before);
  });

  it("recolours a block edited from inside", async () => {
    await getSharedHighlighter({ themes: ["pierre-light", "pierre-dark"], langs: ["ts"] });
    const target = highlighted('<pre><code class="language-ts">const a = 1;</code></pre>');
    await expect.poll(coloured, { timeout: 10_000 }).toBeGreaterThan(0);
    const before = colours();

    const endOfCode = target.state.doc.firstChild!.nodeSize - 1;
    target.view.dispatch(target.state.tr.insertText(' const b = "x";', endOfCode));

    expect(colours().length).toBeGreaterThan(before.length);
    expect(colours().some((entry) => entry.startsWith('"x"'))).toBe(true);
  });

  it("drops the colours of a block that stops being code", async () => {
    await getSharedHighlighter({ themes: ["pierre-light", "pierre-dark"], langs: ["ts"] });
    const target = highlighted('<pre><code class="language-ts">const a = 1;</code></pre><p>After</p>');
    await expect.poll(coloured, { timeout: 10_000 }).toBeGreaterThan(0);

    target.chain().setTextSelection(2).setParagraph().run();

    expect(target.state.doc.firstChild!.type.name).toBe("paragraph");
    expect(target.view.dom.querySelectorAll("p span[style]")).toHaveLength(0);
  });

  it("recolours a block whose language changes in place", async () => {
    await getSharedHighlighter({ themes: ["pierre-light", "pierre-dark"], langs: ["ts"] });
    const target = highlighted('<pre><code class="language-ts">const a = 1;</code></pre>');
    await expect.poll(coloured, { timeout: 10_000 }).toBeGreaterThan(0);

    // An attr step: it moves nothing, so its step map is empty.
    target.view.dispatch(target.state.tr.setNodeAttribute(0, "language", null));

    expect(coloured()).toBe(0);
  });
});

