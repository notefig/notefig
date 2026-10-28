/**
 * Diff blocks in rendered markdown (chat, widget responses). markdown-it
 * renders one as any fence, `<pre><code class="language-diff:…">`; each is
 * swapped for its diff (./view.ts). A render that keeps a block — every
 * chunk of a streaming reply after it, a re-render of the same message —
 * gets the same drawn diff back, moved into place, so only new or changed
 * blocks are drawn.
 */
import { parseDiffBlock } from "./syntax";
import { mountDiffView } from "./view";

const CLASS_PREFIX = "language-";

interface Drawn {
  host: HTMLElement;
  destroy: () => void;
  /** The fence it stands in for, put back by `destroy`. */
  pre: Element;
}

export interface DiffBlockHydrator {
  /** Draws the diff blocks in `root`'s HTML. */
  hydrate(root: HTMLElement): void;
  /** Frees every diff, the fences back where they stood. */
  destroy(): void;
}

/** By source: a message may repeat a block. */
type Views = Map<string, Drawn[]>;

const add = (views: Views, key: string, view: Drawn) => views.set(key, [...(views.get(key) ?? []), view]);
const each = (views: Views) => [...views.values()].flat();

export function createDiffBlockHydrator(): DiffBlockHydrator {
  let drawn: Views = new Map();

  return {
    hydrate(root) {
      // A diff still in `root` stays; one its new HTML dropped may be reused.
      const kept: Views = new Map();
      const spare: Views = new Map();
      for (const [key, list] of drawn) {
        for (const view of list) add(root.contains(view.host) ? kept : spare, key, view);
      }
      for (const code of root.querySelectorAll(`pre > code[class^="${CLASS_PREFIX}diff:"]`)) {
        const language = code.className.split(" ")[0].slice(CLASS_PREFIX.length);
        // markdown-it ends every fence's text with a newline the source
        // (and the editor's code block) doesn't have.
        const text = (code.textContent ?? "").replace(/\n$/, "");
        const block = parseDiffBlock(language, text);
        if (!block) continue;
        const key = `${language}\n${text}`;
        const pre = code.parentElement!;
        const view = spare.get(key)?.shift() ?? { ...mountDiffView(block), pre };
        view.pre = pre;
        pre.replaceWith(view.host);
        add(kept, key, view);
      }
      for (const { destroy } of each(spare)) destroy();
      drawn = kept;
    },
    destroy() {
      for (const { host, destroy, pre } of each(drawn)) {
        if (host.isConnected) host.replaceWith(pre);
        destroy();
      }
      drawn = new Map();
    },
  };
}
