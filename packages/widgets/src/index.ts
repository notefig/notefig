/**
 * @notefig/widgets — custom ProseMirror nodes that carry their own markdown
 * form and render as interactive chrome.
 *
 * Start at define-widget.ts: it states the shape every widget in here
 * conforms to, and why. The prompt widget (prompt/) is the reference
 * implementation.
 */
export {
  defineEditorWidget,
  UI_ONLY_TRANSACTION_META,
  type EditorWidgetDefinition,
  type WidgetMarkerCodec,
} from "./define-widget";

export {
  editorWidgets,
  widgetRendererNodes,
  widgetSchemaNodes,
} from "./registry";

// ─── the prompt widget ────────────────────────────────────────────────────
export { promptWidget } from "./prompt";
export { PROMPT_DRAFT_NODE_NAME, PROMPT_NODE_NAME } from "./prompt/node";
export {
  PromptWidgetHostProvider,
  usePromptWidgetHost,
} from "./prompt/host-context";
export type {
  MentionCandidate,
  PromptRound,
  PromptWidgetHost,
  SessionOption,
  WidgetPromptTarget,
} from "./prompt/host";

/** The on-disk marker (MET-163) — read by the app's emptiness checks. */
export {
  parsePromptMarker,
  serializePromptMarker,
  stripPromptMarkers,
  type PromptMarker,
} from "./prompt/marker-codec";

/**
 * Document helpers the host editor also needs: `docHasRealContent` gates the
 * editor's own emptiness decisions, and `registerContentlessNodeName` is how
 * the app declares its own no-content nodes (frontmatter).
 */
export {
  docHasPromptNode,
  docHasRealContent,
  findPromptNodeId,
  findPromptNodePos,
  promptDraftRange,
  registerContentlessNodeName,
  removeToParagraphTr,
  revertToSlashTr,
  selectionDraft,
} from "./prompt/doc-helpers";

/** The standalone composer and its copy affordance, for the chat tab —
 *  which has no host document to put a draft in. */
export {
  PromptEditor,
  type PromptEditorHandle,
} from "./prompt/composer/prompt-editor";
export { extractMentionPaths } from "./prompt/composer/draft-text";
export { CopyTextButton } from "./prompt/ui/copy-text-button";

/** The document's mention popup: mounted beside the editor, like the link
 *  and table menus, because the suggestion lives on the document. The
 *  service registration is the popup's seam with the widget's key handling
 *  (an open popup claims Enter/Escape and the vertical arrows), exported so
 *  the app's tests can stand in for a mounted menu. */
export { PromptMentionMenu } from "./prompt/composer/mention-menu";
export {
  registerMentionService,
  type MentionService,
} from "./prompt/composer/mention-bridge";

/** Widget state the app reaches into. */
export {
  getPromptBlob,
  subscribePromptBlob,
  updatePromptBlob,
  type PromptBlobRecord,
} from "./prompt/store";

/**
 * The translation keys this package resolves — the host application owns the
 * strings, and asserts against this list that it defines every one.
 */
export { PROMPT_WIDGET_I18N_KEYS } from "./prompt/i18n-keys";

/** Pure state derivations, reused by the app's chat composer. */
export {
  deriveComposerButton,
  deriveComposerKeyAction,
  type ComposerButtonMode,
  type ComposerKeyAction,
} from "./prompt/state";
