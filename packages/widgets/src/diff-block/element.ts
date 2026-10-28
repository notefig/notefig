/**
 * `<notefig-diff-block>`: draws the diff block it holds, a `<pre><code>` in
 * the block's language with its diff (./syntax.ts) as `data-diff`, with
 * `@pierre/diffs` — the library the code viewer is built on, highlighting
 * with the Shiki document code blocks share. Rendered markdown holds one per
 * diff fence (./markdown.ts), so chat and widget responses need no code of
 * their own; the editor draws its diff blocks with one (./extension.ts).
 *
 * Side by side where it is wide enough for both, and has both; one unified
 * column otherwise. Wrapped, never scrolled sideways. It follows the app's theme with no code: Pierre's colours
 * are `light-dark()` pairs, picked by the page's `color-scheme` (dark under
 * `html.dark`), once its host stops asking for the OS's. A block with no
 * separator stays the code it holds.
 */
import { FileDiff, type SupportedLanguages } from "@pierre/diffs";
import { bundledLanguages } from "shiki";
import { DIFF_BLOCK_TAG, DIFF_DATA_ATTRIBUTE, parseDiffSides } from "./syntax";

const LANGUAGE_PREFIX = "language-";
/** The narrowest a block shows its sides side by side at. */
const SPLIT_MIN_WIDTH = 640;

/**
 * Into the shadow root's `@layer unsafe`. The colour scheme is the page's
 * (Pierre's own `light dark` follows the OS), the background the app's (the
 * code viewer's move; Pierre mixes every tint against it), and the code is
 * sized against the frame as a code block's is against its `<pre>`.
 */
const CSS = `
:host {
  color-scheme: inherit;
  --diffs-light-bg: hsl(var(--background));
  --diffs-dark-bg: hsl(var(--background));
  --diffs-font-size: 0.8571429em;
  --diffs-line-height: 1.6667em;
}
`;

/** The Shiki language of a block's code: "text" for one Shiki doesn't know
 *  — Pierre would load it, and reject. */
export function diffBlockLanguage(language: string | null): SupportedLanguages {
  return (language && Object.prototype.hasOwnProperty.call(bundledLanguages, language) ? language : "text") as SupportedLanguages;
}

class DiffBlockElement extends HTMLElement {
  #drawn: { frame: HTMLElement; pre: HTMLElement; diff: FileDiff; resizes: ResizeObserver } | null = null;

  connectedCallback() {
    // Once its children are in: a parser may connect it before them.
    queueMicrotask(() => {
      if (this.isConnected) this.#draw();
    });
  }

  #draw() {
    const code = this.querySelector("pre > code");
    const sides = code && parseDiffSides(code.textContent ?? "");
    if (!code || !sides || this.#drawn) return;
    const pre = code.parentElement!;
    const file = code.getAttribute(DIFF_DATA_ATTRIBUTE) ?? "";
    const language = [...code.classList].find((name) => name.startsWith(LANGUAGE_PREFIX));
    const lang = diffBlockLanguage(language?.slice(LANGUAGE_PREFIX.length) ?? null);
    const frame = document.createElement("div");
    // select-text: the app turns selection off everywhere it isn't asked
    // for; Pierre keeps its gutters unselectable, so a copy is the code alone.
    frame.className = "select-text my-2 overflow-hidden rounded-md border border-border text-[0.8571429em]";
    const options = { overflow: "wrap", disableFileHeader: !file, unsafeCSS: CSS } as const;
    const canSplit = sides.before !== "" && sides.after !== "";
    const styleAt = (width: number): "split" | "unified" => (canSplit && width >= SPLIT_MIN_WIDTH ? "split" : "unified");
    pre.hidden = true;
    this.classList.add("block");
    this.append(frame);
    let style = styleAt(this.clientWidth);
    const diff = new FileDiff({ ...options, diffStyle: style });
    diff.render({
      oldFile: { name: file, contents: sides.before, lang },
      newFile: { name: file, contents: sides.after, lang },
      containerWrapper: frame,
    });
    const resizes = new ResizeObserver(([entry]) => {
      const next = styleAt(entry.contentRect.width);
      if (next === style) return;
      style = next;
      diff.setOptions({ ...options, diffStyle: style });
      diff.rerender();
    });
    if (canSplit) resizes.observe(this);
    this.#drawn = { frame, pre, diff, resizes };
  }

  disconnectedCallback() {
    if (!this.#drawn) return;
    const { frame, pre, diff, resizes } = this.#drawn;
    resizes.disconnect();
    diff.cleanUp();
    frame.remove();
    pre.hidden = false;
    this.#drawn = null;
  }
}

/** Lets the page draw diff blocks; the app does it once, at boot. */
export function defineDiffBlockElement(): void {
  if (!customElements.get(DIFF_BLOCK_TAG)) customElements.define(DIFF_BLOCK_TAG, DiffBlockElement);
}

/** The element for a block, as rendered markdown holds one. */
export function createDiffBlockElement(language: string | null, diff: string, text: string): HTMLElement {
  defineDiffBlockElement();
  const element = document.createElement(DIFF_BLOCK_TAG);
  const pre = element.appendChild(document.createElement("pre"));
  const code = pre.appendChild(document.createElement("code"));
  if (language) code.className = LANGUAGE_PREFIX + language;
  code.setAttribute(DIFF_DATA_ATTRIBUTE, diff);
  code.textContent = text;
  return element;
}
