/**
 * The process block's worker-safe half: schema node + markdown spec, per
 * rule 1 of the widget protocol (../define-widget.ts). The renderer half is
 * node-view.tsx.
 */
import { Node } from "@tiptap/core";
import { replaceMarkerComments } from "../marker-comments";
import { parseProcessMarkerData, serializeProcessMarker } from "./marker-codec";

export const PROCESS_NODE_NAME = "processBlock";

/** The prompt's id form (`blob_<base36>`), which the marker's charset admits. */
const newBlobId = () =>
  `blob_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

/**
 * A leaf block: everything it shows (the command, the process's output)
 * is chrome, so it has no content of its own. In the file it is its marker
 * comment (marker-codec.ts) and nothing else.
 */
export const ProcessNodeBase = Node.create({
  name: PROCESS_NODE_NAME,
  group: "block",
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      // Per-instance identity, keying the block's state in the process
      // blocks service, as a prompt widget's keys its round.
      blobId: { default: null },
      command: { default: null },
    };
  },

  parseHTML() {
    // The marker, rewritten by the parse hook below, and the clipboard's
    // copy (renderHTML), which carries the command but not the identity —
    // a pasted block is a new block, with an output of its own.
    return [
      {
        tag: 'div[data-type="process"]',
        getAttrs: (element) => ({
          blobId: element.getAttribute("data-blob-id") ?? newBlobId(),
          command: element.getAttribute("data-command"),
        }),
      },
    ];
  },

  renderHTML({ node }) {
    return ["div", { "data-type": "process", "data-command": node.attrs.command }];
  },

  addStorage() {
    return {
      markdown: {
        serialize(
          state: {
            write: (s: string) => void;
            closeBlock: (node: unknown) => void;
          },
          node: { attrs: { blobId: string | null; command: string | null } },
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
