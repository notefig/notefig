/**
 * `<notefig-mermaid-block>`: draws the mermaid block it holds — a
 * `<pre><code class="language-mermaid">` (./syntax.ts) — as its card
 * (./card.tsx). Rendered markdown holds one per mermaid fence
 * (./markdown.ts), so chat and widget responses need no code of their own;
 * the editor draws its mermaid blocks with one (./extension.ts).
 */
import { createRoot, type Root } from "react-dom/client";
import type { DrawnBlockElement } from "../drawn-block/extension";
import { MermaidCard, mermaidControls } from "./card";
import { MERMAID_BLOCK_TAG, MERMAID_LANGUAGE } from "./syntax";

class MermaidBlock extends HTMLElement implements DrawnBlockElement {
  onEdit?: () => void;
  #keys = false;
  #drawn: { frame: HTMLElement; pre: HTMLElement; root: Root; source: string } | null = null;

  get keys() {
    return this.#keys;
  }

  set keys(keys: boolean) {
    if (keys === this.#keys) return;
    this.#keys = keys;
    this.#render();
  }

  runControl(index: number): boolean {
    if (!this.#drawn) return false;
    const control = mermaidControls(this.onEdit)[index];
    control?.();
    return control !== undefined;
  }

  connectedCallback() {
    // Once its children are in: a parser may connect it before them.
    queueMicrotask(() => {
      if (this.isConnected) this.#draw();
    });
  }

  #draw() {
    const code = this.querySelector("pre > code");
    const source = code?.textContent ?? "";
    if (!code || this.#drawn || !source.trim()) return;
    const pre = code.parentElement!;
    const frame = document.createElement("div");
    frame.className = "my-2";
    pre.hidden = true;
    this.classList.add("block");
    this.append(frame);
    this.#drawn = { frame, pre, root: createRoot(frame), source };
    this.#render();
  }

  #render() {
    if (!this.#drawn) return;
    const { root, source } = this.#drawn;
    root.render(<MermaidCard source={source} onEdit={this.onEdit} keys={this.#keys} />);
  }

  disconnectedCallback() {
    if (!this.#drawn) return;
    const { frame, pre, root } = this.#drawn;
    this.#drawn = null;
    frame.remove();
    pre.hidden = false;
    // Not inside the render that may be removing it.
    queueMicrotask(() => root.unmount());
  }
}

/** Lets the page draw mermaid blocks; the app does it once, at boot. */
export function defineMermaidBlockElement(): void {
  if (!customElements.get(MERMAID_BLOCK_TAG)) customElements.define(MERMAID_BLOCK_TAG, MermaidBlock);
}

/** The element for a block, as rendered markdown holds one. */
export function createMermaidBlockElement(source: string): DrawnBlockElement {
  defineMermaidBlockElement();
  const element = document.createElement(MERMAID_BLOCK_TAG) as MermaidBlock;
  const pre = element.appendChild(document.createElement("pre"));
  const code = pre.appendChild(document.createElement("code"));
  code.className = `language-${MERMAID_LANGUAGE}`;
  code.textContent = source;
  return element;
}
