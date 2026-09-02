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

/** The draft child's node name — the composer's text, as document content. */
export const PROMPT_DRAFT_NODE_NAME = "promptDraft";

/**
 * The composer's text, as a node of the host document.
 *
 * This is what puts the widget inside the editor's own lifecycle: the caret
 * in a prompt is an ordinary ProseMirror selection, so selection memory,
 * viewport memory and the focus arbiter reach it with no widget-shaped
 * special cases. The node view renders it through NodeViewContent.
 *
 * The schema is the isolation mechanism, not a pile of guards:
 *  - `marks: ""` — every mark the document defines (bold, italic, code,
 *    link, highlight, sub/sup, underline) is inadmissible here, so their
 *    input rules, keymaps and toolbar commands no-op inside a draft.
 *  - the parent's content expression admits only this node, so heading /
 *    list / blockquote / code-block conversions and `splitBlock` all fail
 *    `canReplaceWith` and no-op too.
 *  - `isolating` keeps Backspace, joins and drags from crossing the edge.
 * `image` is absent from the content expression, which is what stops the
 * editor's image drop/paste handlers from inserting into a draft.
 *
 * It never reaches the file: the widget's serializer below writes its
 * marker from attrs alone and never renders children. The no-op serializer
 * here is the belt for that — without one, tiptap-markdown's HTML fallback
 * would write the draft into the user's document.
 */
export const PromptDraftNodeBase = Node.create({
  name: PROMPT_DRAFT_NODE_NAME,
  content: "(text | mention | hardBreak)*",
  marks: "",
  isolating: true,
  selectable: false,
  // Deliberately not in the "block" group: the only place the schema admits
  // it is the widget's own content expression, so ProseMirror itself
  // forbids one appearing anywhere else in the document.

  parseHTML() {
    return [{ tag: 'div[data-type="prompt-draft"]' }];
  },

  renderHTML() {
    return ["div", { "data-type": "prompt-draft" }, 0];
  },

  addStorage() {
    return {
      markdown: {
        // Unreachable through the widget (its serializer never renders
        // children) — this is the belt, not the mechanism.
        serialize() {},
      },
    };
  },
});

/**
 * The inline AI prompt widget's schema node — a block whose presence in the
 * file depends on whether it is bound to an agent session (MET-163).
 *
 * Unbound (the empty-doc keeper, a widget summoned with "/" but never sent)
 * it is pure UI and serializes to NOTHING: an untouched document must stay
 * byte-identical on disk. Once it is bound to a task it becomes real content
 * and serializes to its marker comment — see marker-codec.ts for why a
 * comment and why only two ids. Without either branch tiptap-markdown's html
 * fallback would write the node's placeholder <div> into the file.
 *
 * Its content is the draft the user types (PromptDraftNodeBase above) —
 * never serialized, which is what keeps a half-written prompt out of the
 * file while still letting the document own the caret.
 */
export const AiPromptNodeBase = Node.create({
  name: PROMPT_NODE_NAME,
  group: "block",
  content: PROMPT_DRAFT_NODE_NAME,
  isolating: true,
  selectable: true,
  // No gap cursor between the widget's edges and its draft child: those two
  // gaps are phantom caret stops (arrowing through the widget took two
  // presses and drew a blinking line over the chrome). Honoured by
  // prosemirror-gapcursor via the schema spec, so it belongs to the
  // worker-safe half even though only the live editor loads Gapcursor.
  allowGapCursor: false,

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
