/**
 * The AI prompt widget, assembled per the protocol in ../define-widget.ts:
 * a worker-safe `base`, a host-bound `view`, and a pure markdown `codec`.
 */
import { defineEditorWidget } from "../define-widget";
import {
  parsePromptMarker,
  serializePromptMarker,
  stripPromptMarkers,
  type PromptMarker,
} from "./marker-codec";
import { AiPromptNodeBase, PROMPT_NODE_NAME } from "./node";
import { AiPromptNode, type AiPromptNodeOptions } from "./node-view";

export const promptWidget = defineEditorWidget<AiPromptNodeOptions>({
  name: PROMPT_NODE_NAME,
  base: AiPromptNodeBase,
  view: AiPromptNode,
  codec: {
    serialize: (marker) =>
      serializePromptMarker(marker as Partial<PromptMarker>),
    parse: parsePromptMarker,
    strip: stripPromptMarkers,
  },
  // The "/" summon may replace a list item's only paragraph with the widget
  // (MET-93) — the host editor widens listItem/taskItem content accordingly.
  inlineHostable: true,
});
