/**
 * A diff block (./syntax.ts) drawn by `@pierre/diffs` — the library the code
 * viewer is built on, highlighting with the Shiki document code blocks
 * share. One unified, wrapped column: the block sits in prose and chat, too
 * narrow for split sides. It follows the app's theme with no code: Pierre's
 * colours are `light-dark()` pairs, picked by the page's `color-scheme`
 * (dark under `html.dark`), once its host stops asking for the OS's.
 *
 * It stands where a `<pre>` would — in the editor beside its hidden code
 * block, in rendered markdown in place of it — so it is sized like one.
 */
import { FileDiff, getFiletypeFromFileName, type SupportedLanguages } from "@pierre/diffs";
import { bundledLanguages } from "shiki";
import type { DiffBlock } from "./syntax";

/**
 * Into the shadow root's `@layer unsafe`. The colour scheme is the page's
 * (Pierre's own `light dark` follows the OS), the background the app's (the
 * code viewer's move; Pierre mixes every tint against it), and the code is
 * sized against the host as a code block's is against its `<pre>`.
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

/** The Shiki language of a diff block's code: inferred from its path, or
 *  the one it names. "text" for one Shiki doesn't know — Pierre would load
 *  it, and reject. */
export function diffBlockLanguage({ path, language }: Pick<DiffBlock, "path" | "language">): string {
  if (path) return getFiletypeFromFileName(path);
  return language && Object.prototype.hasOwnProperty.call(bundledLanguages, language) ? language : "text";
}

/** A host element drawing `block`, and what frees it. */
export function mountDiffView(block: DiffBlock): { host: HTMLElement; destroy: () => void } {
  const host = document.createElement("div");
  // select-text: the app turns selection off everywhere it isn't asked for;
  // Pierre keeps its gutters unselectable, so a copy is the code alone.
  host.className = "diff-block select-text my-2 overflow-hidden rounded-md border border-border text-[0.8571429em]";
  const diff = new FileDiff({
    diffStyle: "unified",
    overflow: "wrap",
    disableFileHeader: !block.path,
    unsafeCSS: CSS,
  });
  const name = block.path ?? "";
  const lang = diffBlockLanguage(block) as SupportedLanguages;
  diff.render({
    oldFile: { name, contents: block.before, lang },
    newFile: { name, contents: block.after, lang },
    containerWrapper: host,
  });
  return { host, destroy: () => diff.cleanUp() };
}
