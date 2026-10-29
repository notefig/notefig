/**
 * `<notefig-diff-block>`: draws the diff block it holds — a `<pre><code>`
 * in the block's language marked `data-diff` (./syntax.ts) — as its card
 * (./card.tsx). Rendered markdown holds one per diff fence (./markdown.ts),
 * so chat and widget responses need no code of their own; the editor draws
 * its diff blocks with one (./extension.ts), and the chat an agent's edits
 * (./transcript.tsx). A body Pierre finds no hunks in stays the code it is.
 *
 * Which workspace a relative path is in is the page's to say: the nearest
 * `data-workspace-path`, the element's own included. `data-collapsed` on the
 * element starts its card closed (./card.tsx).
 */
import type { ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { FileDiffMetadata } from "@pierre/diffs";
import { DiffCard, diffControls, type DiffFile } from "./card";
import { parseDiffBlock } from "./patch";
import { COLLAPSED_ATTRIBUTE, DIFF_BLOCK_TAG, DIFF_DATA_ATTRIBUTE } from "./syntax";

const LANGUAGE_PREFIX = "language-";
export const WORKSPACE_ATTRIBUTE = "data-workspace-path";

/** What only the app knows: which files exist, how one opens, and how its
 *  type is drawn. */
export interface DiffBlockHost {
  /** The file `path` (absolute, or relative to `workspacePath`) names. */
  resolveFile(workspacePath: string | null, path: string): DiffFile;
  FileIcon?: ComponentType<{ path: string; className?: string }>;
}

/** The element; the editor hands it a way into the block's source, and
 *  says when the keys are on it. */
export interface DiffBlockElement extends HTMLElement {
  onEdit?: () => void;
  /** Its diff, where whoever made it has read it already; else it reads
   *  its code. */
  diff?: FileDiffMetadata;
  /** The keys are on the card: its controls show their digits. */
  keys: boolean;
  /** Runs the card's `index`th control (diffControls); false when it has
   *  none there, or isn't drawn. */
  runControl(index: number): boolean;
}

function elementClass(host: DiffBlockHost | null) {
  return class extends HTMLElement implements DiffBlockElement {
    onEdit?: () => void;
    diff?: FileDiffMetadata;
    #keys = false;
    #drawn: { frame: HTMLElement; pre: HTMLElement; root: Root; diff: FileDiffMetadata; file: DiffFile } | null = null;

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
      const control = diffControls(this.onEdit, this.#drawn.file)[index];
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
      if (!code || this.#drawn) return;
      const language = [...code.classList].find((name) => name.startsWith(LANGUAGE_PREFIX));
      const diff = this.diff ?? parseDiffBlock(language?.slice(LANGUAGE_PREFIX.length) ?? null, code.textContent ?? "");
      if (!diff) return;
      const pre = code.parentElement!;
      const workspace = this.closest(`[${WORKSPACE_ATTRIBUTE}]`)?.getAttribute(WORKSPACE_ATTRIBUTE) ?? null;
      const file = host?.resolveFile(workspace, diff.name) ?? { label: diff.name };
      const frame = document.createElement("div");
      frame.className = "my-2";
      pre.hidden = true;
      this.classList.add("block");
      this.append(frame);
      this.#drawn = { frame, pre, root: createRoot(frame), diff, file };
      this.#render();
    }

    #render() {
      if (!this.#drawn) return;
      const { root, diff, file } = this.#drawn;
      const { FileIcon } = host ?? {};
      root.render(
        <DiffCard
          diff={diff}
          file={file}
          icon={FileIcon && <FileIcon path={file.label} className="size-3 shrink-0" />}
          onEdit={this.onEdit}
          keys={this.#keys}
          collapsible={this.hasAttribute(COLLAPSED_ATTRIBUTE)}
        />,
      );
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
  };
}

/** Lets the page draw diff blocks; the app does it once, at boot, with what
 *  only it knows. */
export function defineDiffBlockElement(host: DiffBlockHost | null = null): void {
  if (!customElements.get(DIFF_BLOCK_TAG)) customElements.define(DIFF_BLOCK_TAG, elementClass(host));
}

/** The element for a block, as rendered markdown holds one; `diff`, where
 *  the caller has read it already. */
export function createDiffBlockElement(language: string | null, text: string, diff?: FileDiffMetadata): DiffBlockElement {
  defineDiffBlockElement();
  const element = document.createElement(DIFF_BLOCK_TAG) as DiffBlockElement;
  element.diff = diff;
  const pre = element.appendChild(document.createElement("pre"));
  const code = pre.appendChild(document.createElement("code"));
  if (language) code.className = LANGUAGE_PREFIX + language;
  code.setAttribute(DIFF_DATA_ATTRIBUTE, "");
  code.textContent = text;
  return element;
}
