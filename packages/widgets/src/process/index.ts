/**
 * The process block, assembled per the protocol in ../define-widget.ts like
 * the prompt widget (../prompt/index.ts): a worker-safe `base`, a `view`
 * over the document's services, and a pure markdown `codec`.
 */
import { defineEditorWidget } from "../define-widget";
import {
  parseProcessMarker,
  serializeProcessMarker,
  stripProcessMarkers,
} from "./marker-codec";
import { PROCESS_NODE_NAME, ProcessNodeBase } from "./node";
import { ProcessNode } from "./node-view";

export const processWidget = defineEditorWidget({
  name: PROCESS_NODE_NAME,
  base: ProcessNodeBase,
  view: ProcessNode,
  codec: {
    serialize: serializeProcessMarker,
    parse: parseProcessMarker,
    strip: stripProcessMarkers,
  },
});
