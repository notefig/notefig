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
  captureSelectionReference,
  deleteWidgetTr,
  docHasPromptNode,
  docHasRealContent,
  findPromptNodeId,
  findPromptNodePos,
  MAX_REFERENCE_CHARS,
  promptDraftRange,
  registerContentlessNodeName,
  removeToParagraphTr,
  revertToSlashTr,
  selectionDraft,
  selectionSummonTr,
  type PromptReference,
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

/** "@" page links (MET-78) for the host editor's ordinary prose — the
 *  complement of the widget's draft-scoped mention suggestion, sharing its
 *  popup service. The application injects its href policy via `buildHref`. */
export {
  PageLinkSuggestion,
  pageLinkLabel,
  type PageLinkSuggestionOptions,
} from "./page-link";

/** Widget state the app reaches into. */
export {
  findPromptBlobForTask,
  getPromptBlob,
  subscribePromptBlob,
  updatePromptBlob,
  type PromptBlobLocation,
  type PromptBlobRecord,
} from "./prompt/store";

/** The document minimap (MET-172): the collector the editor registers,
 *  and the live-rows seam the app fills in at setup. */
export { widgetMinimapExtension } from "./registry";
export {
  registerPromptRoundObserver,
  type PromptRoundObserverFactory,
  type PromptRoundSnapshot,
} from "./prompt/minimap";
export {
  deriveMinimapEntries,
  type MinimapDotState,
  type MinimapEntry,
  type MinimapSource,
} from "./minimap/contract";

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
