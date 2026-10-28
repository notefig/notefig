/**
 * `<notefig-diff-block>`: draws the diff block it holds, a `<pre><code>` in
 * the block's language marked `data-diff` (./syntax.ts), with
 * `@pierre/diffs` — the library the code viewer is built on, highlighting
 * with the Shiki document code blocks share. Rendered markdown holds one per
 * diff fence (./markdown.ts), so chat and widget responses need no code of
 * their own; the editor draws its diff blocks with one (./extension.ts).
 *
 * Side by side where it is wide enough and the change has both sides; one
 * unified column otherwise. Wrapped, never scrolled sideways. It follows the
 * app's theme with no code: Pierre's colours are `light-dark()` pairs, picked
 * by the page's `color-scheme` (dark under `html.dark`), once its host stops
 * asking for the OS's. A body Pierre finds no hunks in stays the code it is.
 */
import { FileDiff, processFile, type FileDiffMetadata, type SupportedLanguages } from "@pierre/diffs";
import { bundledLanguages } from "shiki";
import { DIFF_BLOCK_TAG, DIFF_DATA_ATTRIBUTE } from "./syntax";

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

/** The block's language, where Shiki knows it (Pierre would load another,
 *  and reject); else Pierre infers one from the file's name. */
function diffBlockLanguage(language: string | null): SupportedLanguages | undefined {
  const known = language && language !== "text" && Object.prototype.hasOwnProperty.call(bundledLanguages, language);
  return known ? (language as SupportedLanguages) : undefined;
}

/** A block's unified diff as Pierre reads it, or null when it has no hunks. */
export function parseDiffBlock(language: string | null, text: string): FileDiffMetadata | null {
  const parsed = processFile(text);
  if (!parsed?.hunks.length) return null;
  const lang = diffBlockLanguage(language);
  return lang ? { ...parsed, lang } : parsed;
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
    if (!code || this.#drawn) return;
    const language = [...code.classList].find((name) => name.startsWith(LANGUAGE_PREFIX));
    const fileDiff = parseDiffBlock(language?.slice(LANGUAGE_PREFIX.length) ?? null, code.textContent ?? "");
    if (!fileDiff) return;
    const pre = code.parentElement!;
    const frame = document.createElement("div");
    // select-text: the app turns selection off everywhere it isn't asked
    // for; Pierre keeps its gutters unselectable, so a copy is the code alone.
    frame.className = "select-text my-2 overflow-hidden rounded-md border border-border text-[0.8571429em]";
    const options = { overflow: "wrap", disableFileHeader: !fileDiff.name, unsafeCSS: CSS } as const;
    const changed = (side: "additionLines" | "deletionLines") => fileDiff.hunks.some((hunk) => hunk[side] > 0);
    const canSplit = changed("additionLines") && changed("deletionLines");
    const styleAt = (width: number): "split" | "unified" => (canSplit && width >= SPLIT_MIN_WIDTH ? "split" : "unified");
    pre.hidden = true;
    this.classList.add("block");
    this.append(frame);
    let style = styleAt(this.clientWidth);
    const diff = new FileDiff({ ...options, diffStyle: style });
    diff.render({ fileDiff, containerWrapper: frame });
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
export function createDiffBlockElement(language: string | null, text: string): HTMLElement {
  defineDiffBlockElement();
  const element = document.createElement(DIFF_BLOCK_TAG);
  const pre = element.appendChild(document.createElement("pre"));
  const code = pre.appendChild(document.createElement("code"));
  if (language) code.className = LANGUAGE_PREFIX + language;
  code.setAttribute(DIFF_DATA_ATTRIBUTE, "");
  code.textContent = text;
  return element;
}
