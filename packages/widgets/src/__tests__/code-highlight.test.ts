import { describe, it, expect, afterEach } from "vitest";
import { Editor, Extension } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { getSharedHighlighter } from "@pierre/diffs";
import { codeHighlight } from "../code-highlight";

let editor: Editor | null = null;
afterEach(() => editor?.destroy());

const coloured = () => editor!.view.dom.querySelectorAll("pre code span[style]").length;

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
});
