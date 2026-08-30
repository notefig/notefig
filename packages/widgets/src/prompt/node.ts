/**
 * The prompt widget's worker-safe half: schema node + markdown spec, per
 * rule 1 of the widget protocol (see ../define-widget.ts). No React, no live
 * DOM — this is the definition the markdown conversion Web Worker builds its
 * schema from, and sharing it with the renderer half (node-view.tsx) is what
 * makes the worker's parse/serialize output identical to the editor's.
 */
import { Node } from "@tiptap/core";
import { parsePromptMarkerData, serializePromptMarker } from "./marker-codec";

/** The schema node name. Exported so callers compose content expressions
 *  from it instead of repeating the string literal. */
export const PROMPT_NODE_NAME = "aiPrompt";

/**
 * The inline AI prompt widget's schema node — a block atom whose presence in
 * the file depends on whether it is bound to an agent session (MET-163).
 *
 * Unbound (the empty-doc keeper, a widget summoned with "/" but never sent)
 * it is pure UI and serializes to NOTHING: an untouched document must stay
 * byte-identical on disk. Once it is bound to a task it becomes real content
 * and serializes to its marker comment — see marker-codec.ts for why a
 * comment and why only two ids. Without either branch tiptap-markdown's html
 * fallback would write the node's placeholder <div> into the file.
 */
export const AiPromptNodeBase = Node.create({
  name: PROMPT_NODE_NAME,
  group: "block",
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      // True for instances summoned by typing "/" — gates the revert-to-"/"
      // contract (Esc / a second "/" turn the widget back into a literal
      // slash). Keeper-inserted nodes stay false. Never serialized.
      summoned: { default: false },
      // Per-instance identity: every widget keys its own state (draft,
      // bound turn) in store.ts by this id — a document can hold several
      // widgets, so the document path is not identity enough.
      // Minted at every creation site; null only for schema-default nodes,
      // which the node view repairs on mount. Serialized only alongside a
      // taskId: it is what makes an adopted re-parse (an agent writing this
      // file mid-round) land back on this widget's live state rather than a
      // fresh empty one.
      blobId: { default: null },
      // The agent task whose session this widget's round belongs to. Set at
      // send time by the node view, null while composing. Its presence is
      // what turns the widget from UI into file content.
      taskId: { default: null },
    };
  },

  parseHTML() {
    // Two sources: markdown (the marker comment, rewritten into this shape
    // by the parse hook below, carrying both ids) and internal HTML
    // round-trips (clipboard), whose renderHTML output has no attrs — those
    // land id-less and the node view mints a fresh identity on mount.
    return [
      {
        tag: 'div[data-type="ai-prompt"]',
        getAttrs: (element) => {
          const blobId = element.getAttribute("data-blob-id");
          const taskId = element.getAttribute("data-task-id");
          return {
            ...(blobId ? { blobId } : {}),
            ...(taskId ? { taskId } : {}),
          };
        },
      },
    ];
  },

  renderHTML() {
    // Deliberately attr-less: copying a widget must not clone its identity
    // into a second widget sharing one round's state.
    return ["div", { "data-type": "ai-prompt" }];
  },

  addStorage() {
    return {
      markdown: {
        serialize(
          state: {
            write: (s: string) => void;
            closeBlock: (node: unknown) => void;
          },
          node: { attrs: { blobId: string | null; taskId: string | null } },
        ) {
          const marker = serializePromptMarker(node.attrs);
          // Unbound: contributes nothing to the file.
          if (!marker) return;
          state.write(marker);
          state.closeBlock(node);
        },
        parse: {
          updateDOM(element: HTMLElement) {
            replacePromptMarkerComments(element);
          },
        },
      },
    };
  },
});

/**
 * Rewrite our marker comments into the element `parseHTML` above matches.
 *
 * This hook is the last moment the comments exist: markdown-it emits them
 * verbatim (html: true) and DOMParser keeps them, but ProseMirror's own
 * DOMParser handles only element and text nodes, so anything still a comment
 * by then is dropped without a trace.
 *
 * A manual childNodes recursion rather than querySelectorAll (which cannot
 * select comments) or a TreeWalker (which the conversion worker's linkedom
 * shim does not expose) — plain childNodes works in both DOMs.
 */
function replacePromptMarkerComments(element: HTMLElement): void {
  const COMMENT_NODE = 8;
  const ELEMENT_NODE = 1;
  // `Node` in this module is Tiptap's; the DOM one needs its global name.
  const walk = (parent: globalThis.Node): void => {
    // Snapshot: replaceChild mutates the live childNodes list.
    for (const child of Array.from(parent.childNodes)) {
      if (child.nodeType === ELEMENT_NODE) {
        walk(child);
        continue;
      }
      if (child.nodeType !== COMMENT_NODE) continue;
      const marker = parsePromptMarkerData(
        (child as unknown as { data: string }).data ?? "",
      );
      if (!marker) continue;
      const doc = element.ownerDocument;
      if (!doc) continue;
      const replacement = doc.createElement("div");
      replacement.setAttribute("data-type", "ai-prompt");
      replacement.setAttribute("data-blob-id", marker.blobId);
      replacement.setAttribute("data-task-id", marker.taskId);
      parent.replaceChild(replacement, child);
    }
  };
  walk(element);
}
