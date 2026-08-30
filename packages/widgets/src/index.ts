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
export { PROMPT_NODE_NAME } from "./prompt/node";
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
  registerContentlessNodeName,
  removeToParagraphTr,
  revertToSlashTr,
} from "./prompt/doc-helpers";

/** The composer and its copy affordance, reused by the app's chat tab. */
export {
  PromptEditor,
  extractMentionPaths,
  type PromptEditorHandle,
} from "./prompt/composer/prompt-editor";
export { CopyTextButton } from "./prompt/ui/copy-text-button";

/** Widget state the app's focus lifecycle reaches into. */
export {
  consumePendingPromptBlobFocus,
  getPromptBlob,
  requestPromptBlobFocus,
  subscribePromptBlob,
  subscribePromptBlobFocus,
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
