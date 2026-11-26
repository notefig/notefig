/**
 * Which kind draws a block: the first whose `matches` takes it, even when
 * that kind reads nothing from it; and a block that becomes another kind's
 * is drawn as that kind's card. (The selection and editing rules every kind
 * shares are exercised through diff blocks, ../../diff-block/__tests__.)
 */
import { describe, it, expect, afterEach } from "vitest";
import { Editor, Extension } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import type { Node as PMNode } from "@tiptap/pm/model";
import { drawnCodeBlocks, type DrawnBlockElement, type DrawnBlockKind } from "../extension";

let editor: Editor | null = null;
afterEach(() => {
  editor?.view.dom.parentElement?.remove();
  editor?.destroy();
  editor = null;
});

/** A kind that draws code blocks in `language` as a card naming itself,
 *  unless `reads` is false: then it takes them and leaves them code. */
function kind(name: string, language: string, reads = true): DrawnBlockKind<string> {
  return {
    name,
    matches: (node: PMNode) => node.attrs.language === language,
    read: (node: PMNode) => (reads ? node.textContent : null),
    draw: () => {
      const card = document.createElement("div") as unknown as DrawnBlockElement;
      card.setAttribute("data-card", name);
      card.keys = false;
      card.runControl = () => false;
      return card;
    },
  };
}

function mount(content: string, kinds: DrawnBlockKind<string>[]) {
  editor = new Editor({
    element: document.body.appendChild(document.createElement("div")),
    extensions: [StarterKit, Extension.create({ name: "drawn", addProseMirrorPlugins: () => [drawnCodeBlocks(kinds)] })],
    content,
  });
  return editor;
}

const cards = () => [...editor!.view.dom.querySelectorAll("[data-card]")].map((card) => card.getAttribute("data-card"));

describe("drawnCodeBlocks", () => {
  it("draws each block as the kind that matches it", () => {
    mount('<pre><code class="language-a">1</code></pre><pre><code class="language-b">2</code></pre><pre><code class="language-c">3</code></pre>', [
      kind("a", "a"),
      kind("b", "b"),
    ]);
    expect(cards()).toEqual(["a", "b"]);
  });

  it("leaves a block to the first kind that matches it, even one that reads nothing from it", () => {
    mount('<pre><code class="language-x">1</code></pre>', [kind("first", "x", false), kind("second", "x")]);
    expect(cards()).toEqual([]);
  });

  it("draws a block that changes language as its new kind's card", () => {
    mount('<p>Before</p><pre><code class="language-a">1</code></pre>', [kind("a", "a"), kind("b", "b")]);
    expect(cards()).toEqual(["a"]);
    let at = -1;
    editor!.state.doc.descendants((node, pos) => {
      if (node.type.name === "codeBlock") at = pos;
    });
    const { state, view } = editor!;
    view.dispatch(state.tr.setNodeAttribute(at, "language", "b"));
    expect(cards()).toEqual(["b"]);
  });
});
