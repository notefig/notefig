/**
 * The process block's worker-safe half: schema node + markdown spec, per
 * rule 1 of the widget protocol (../define-widget.ts). The renderer half is
 * node-view.tsx.
 */
import { Node } from "@tiptap/core";
import { replaceMarkerComments } from "../marker-comments";
import { parseProcessMarkerData, serializeProcessMarker } from "./marker-codec";

export const PROCESS_NODE_NAME = "processBlock";

/**
 * A leaf block: everything it shows (the command, the process's output)
 * is chrome, so it has no content of its own. In the file it is its marker
 * comment (marker-codec.ts) and nothing else; the rest is the app's,
 * under its id.
 */
export const ProcessNodeBase = Node.create({
  name: PROCESS_NODE_NAME,
  group: "block",
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      // The app-minted identity, keying the block's registration and state
      // in the process blocks service, as a prompt widget's keys its round.
      blobId: { default: null },
    };
  },

  parseHTML() {
    // The marker, rewritten by the parse hook below, and the clipboard's
    // copy (renderHTML). Either brings an id only: one the app never minted
    // is dropped by the renderer half (node-view.tsx), so a paste can move
    // a block but never make one.
    return [
      {
        tag: 'div[data-type="process"]',
        getAttrs: (element) => ({
          blobId: element.getAttribute("data-blob-id"),
        }),
      },
    ];
  },

  renderHTML({ node }) {
    return [
      "div",
      { "data-type": "process", "data-blob-id": node.attrs.blobId },
    ];
  },

  addStorage() {
    return {
      markdown: {
        serialize(
          state: {
            write: (s: string) => void;
            closeBlock: (node: unknown) => void;
          },
          node: { attrs: { blobId: string | null } },
        ) {
          const marker = serializeProcessMarker(node.attrs);
          if (!marker) return;
          state.write(marker);
          state.closeBlock(node);
        },
        parse: {
          updateDOM(element: HTMLElement) {
            replaceMarkerComments(element, "process", parseProcessMarkerData);
          },
        },
      },
    };
  },
});
