/**
 * `<notefig-diff-block>`: draws the diff block it holds — a `<pre><code>`
 * in the block's language marked `data-diff` (./syntax.ts) — as its card
 * (./card.tsx). Rendered markdown holds one per diff fence (./markdown.ts),
 * so chat and widget responses need no code of their own; the editor draws
 * its diff blocks with one (./extension.ts), and the chat an agent's edits
 * (./transcript.tsx). A body Pierre finds no hunks in stays the code it is.
 *
 * Which workspace a relative path is in is the page's to say: the nearest
 * `data-workspace-path`, the element's own included.
 */
import { createRoot, type Root } from "react-dom/client";
import { useTranslation } from "react-i18next";
import { Pencil } from "lucide-react";
import { DiffCard, type DiffFile } from "./card";
import { parseDiffBlock } from "./patch";
import { DIFF_BLOCK_TAG, DIFF_DATA_ATTRIBUTE } from "./syntax";

const LANGUAGE_PREFIX = "language-";
export const WORKSPACE_ATTRIBUTE = "data-workspace-path";

/** What only the app knows: which files exist, and how one opens. */
export interface DiffBlockHost {
  /** The file `path` (absolute, or relative to `workspacePath`) names. */
  resolveFile(workspacePath: string | null, path: string): DiffFile;
}

/** The element; the editor hands it a way into the block's source. */
export interface DiffBlockElement extends HTMLElement {
  onEdit?: () => void;
}

function elementClass(host: DiffBlockHost | null) {
  return class extends HTMLElement implements DiffBlockElement {
    onEdit?: () => void;
    #drawn: { frame: HTMLElement; pre: HTMLElement; root: Root } | null = null;

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
      const diff = parseDiffBlock(language?.slice(LANGUAGE_PREFIX.length) ?? null, code.textContent ?? "");
      if (!diff) return;
      const pre = code.parentElement!;
      const workspace = this.closest(`[${WORKSPACE_ATTRIBUTE}]`)?.getAttribute(WORKSPACE_ATTRIBUTE) ?? null;
      const file = host?.resolveFile(workspace, diff.name) ?? { label: diff.name };
      const frame = document.createElement("div");
      frame.className = "my-2";
      pre.hidden = true;
      this.classList.add("block");
      this.append(frame);
      const root = createRoot(frame);
      root.render(<DiffCard diff={diff} file={file} actions={this.onEdit && <EditButton onEdit={this.onEdit} />} />);
      this.#drawn = { frame, pre, root };
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

function EditButton({ onEdit }: { onEdit: () => void }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      title={t("diffBlockEdit")}
      aria-label={t("diffBlockEdit")}
      data-diff-edit
      className="flex cursor-pointer items-center rounded p-1 text-muted-foreground transition-colors hover:text-foreground"
      onClick={onEdit}
    >
      <Pencil className="size-3.5" />
    </button>
  );
}

/** Lets the page draw diff blocks; the app does it once, at boot, with what
 *  only it knows. */
export function defineDiffBlockElement(host: DiffBlockHost | null = null): void {
  if (!customElements.get(DIFF_BLOCK_TAG)) customElements.define(DIFF_BLOCK_TAG, elementClass(host));
}

/** The element for a block, as rendered markdown holds one. */
export function createDiffBlockElement(language: string | null, text: string): DiffBlockElement {
  defineDiffBlockElement();
  const element = document.createElement(DIFF_BLOCK_TAG) as DiffBlockElement;
  const pre = element.appendChild(document.createElement("pre"));
  const code = pre.appendChild(document.createElement("code"));
  if (language) code.className = LANGUAGE_PREFIX + language;
  code.setAttribute(DIFF_DATA_ATTRIBUTE, "");
  code.textContent = text;
  return element;
}
