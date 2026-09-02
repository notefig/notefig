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
import {
  AiPromptNodeBase,
  PromptDraftNodeBase,
  PROMPT_NODE_NAME,
} from "./node";
import { promptMentionNode } from "./composer/mention-node";
import { AiPromptNode, type AiPromptNodeOptions } from "./node-view";

export const promptWidget = defineEditorWidget<AiPromptNodeOptions>({
  name: PROMPT_NODE_NAME,
  base: AiPromptNodeBase,
  view: AiPromptNode,
  // The draft the user types is document content, so its node and the
  // mention chip that can sit in it are part of the document schema. The
  // mention's suggestion half stays with the renderer (the widget's own
  // plugins register it, scoped to drafts); the worker only needs the node
  // so its parse/serialize agrees with the editor's.
  support: {
    bases: [PromptDraftNodeBase, promptMentionNode()],
    views: () => [PromptDraftNodeBase, promptMentionNode()],
  },
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
