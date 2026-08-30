/**
 * The editor-widget protocol.
 *
 * A "widget" here is a custom ProseMirror node that (a) has a markdown form
 * of its own and (b) renders as interactive React chrome rather than as
 * prose. The app already had three of these — the AI prompt widget, the
 * frontmatter block, the image node — each wired up its own way, with the
 * schema half, the markdown half, the node view and the UI scattered across
 * different directories. This module states the shape once so the next one
 * has something to conform to.
 *
 * Three rules, and the type below is just their signature:
 *
 * 1. TWO HALVES. `base` is worker-safe: schema + `addStorage().markdown`
 *    serialize/parse, no React and no live DOM. `view()` is `base.extend()`
 *    adding the node view and any ProseMirror plugins. The split is not
 *    stylistic — the markdown conversion Web Worker builds its schema from
 *    the bases alone, and it is the fact that both halves share one `base`
 *    that guarantees the worker's parse/serialize output is identical to the
 *    live editor's.
 *
 * 2. THE CODEC IS PURE. A widget that persists to markdown owns one
 *    Tiptap-free module over plain strings (`serialize` / `parse` /
 *    `strip`). It can then be unit-tested without a schema, and non-editor
 *    callers — the scratchpad emptiness check, for one — can ask "is there
 *    anything of ours in this file?" without loading the editor.
 *
 * 3. NOTHING IMPURE IS IMPORTED. Everything a widget cannot compute from
 *    its own document — sessions, live rows, tabs, workspace files — arrives
 *    through one typed host object, passed in at registration. That is what
 *    lets this package hold the widget end to end without depending on the
 *    app it runs in.
 */
import type { Node } from "@tiptap/core";

/**
 * A widget's markdown form, independent of Tiptap. `strip` answers "what
 * does this file look like with our marks removed?" for callers that need
 * to judge the user's own content (see stripPromptMarkers' docstring).
 */
export interface WidgetMarkerCodec<Marker> {
  serialize(marker: Partial<Marker>): string | null;
  parse(text: string): Marker | null;
  strip(markdown: string): string;
}

export interface EditorWidgetDefinition<Options = unknown> {
  /** Schema node name — must match `base.name`, e.g. "aiPrompt". */
  name: string;
  /** Worker-safe half: schema + markdown spec. No React, no live DOM. */
  base: Node;
  /**
   * Renderer half: `base.extend()` with the node view and plugins, still
   * unconfigured — the host editor calls `.configure(options)` per document.
   * It takes nothing from the application: plugins are document-local, and
   * the node view is React, so it reads the host from context.
   */
  view: Node;
  /** Phantom, for `view.configure()`'s option type at the call site. */
  readonly options?: Options;
  /** Present iff the widget persists to markdown. */
  codec?: WidgetMarkerCodec<unknown>;
  /**
   * True when the widget may stand in for a list item's leading paragraph —
   * i.e. it can be summoned inside a list. The host composes the widened
   * `listItem` / `taskItem` content expressions from the names of the
   * widgets that declare it, instead of hard-coding node names in the
   * schema kit.
   */
  inlineHostable?: boolean;
}

/** Identity helper — exists for the inference, same as `defineBlobType`. */
export function defineEditorWidget<Options>(
  definition: EditorWidgetDefinition<Options>,
): EditorWidgetDefinition<Options> {
  return definition;
}

/**
 * Transactions that only touch widget nodes carry this meta so the autosave
 * path can ignore them: they never change the serialized markdown, and
 * saving would only churn the file watcher. Lives here rather than in the
 * app's schema kit because widgets are the entire reason it exists.
 */
export const UI_ONLY_TRANSACTION_META = "uiOnlyNodeChange";
