/**
 * Tab controllers — the imperative contract every dockable tab type
 * implements, and the registry the app talks to instead of talking to one
 * tab type's store.
 *
 * The dock hosts more than documents (agent sessions, release notes, and
 * whatever comes next), but the controls above it — focus on tab-select,
 * dispose on close, "what is selected?", find-in-tab, undo/redo — are the
 * same questions for all of them. Those questions live here; the answers
 * live with each tab type:
 *
 *   file / release-notes → components/editor/editor-store.ts
 *   agent                → components/agent/agent-tab-controller.ts
 *
 * Each implementation registers itself when its surface becomes live and
 * unregisters when it goes away (direct imports both ways — there is no
 * capability injection). An unregistered tab id simply has no controller
 * yet: generic ops no-op, and `when-mounted` focus intents keep retrying
 * until the tab mounts, which is exactly the wanted semantics for the dock
 * (it unmounts unselected tabs).
 *
 * Not here: anything that only makes sense for one kind of tab. Dirty
 * state, markdown text and the workspace-wide file grep stay file-specific
 * (`entities/editors.ts`, `editor-store.ts`); the agent's session controls
 * stay on the agents facade. `entities/tabs.ts` joins the two sides into
 * one handle: `tab(id)` for the general controls, `tab(id).editor` /
 * `tab(id).agent` for the type-specific ones.
 */
import type { SearchTarget } from "@/adapters/platform-adapter.interface";
import {
  focusArbiter,
  type FocusTiming,
  type TabCaretPlacement,
} from "@/utils/focus-arbiter";
import type { TabKind } from "./tab-id";

export type { SearchTarget as TabSearchMatch };

/** Everything an intent can ask of a tab's focus. */
export interface TabFocusOptions {
  /** Placement hint for tab types with a caret; opaque to this layer. */
  caret?: TabCaretPlacement;
  /**
   * An explicit user hand-off (Escape out of a composer, a menu action).
   * Ambient intents — mount, layout reclaim, tab activation — leave this
   * unset and must never yank focus out of an active text entry.
   */
  steal?: boolean;
}

export interface TabSearchOptions {
  caseSensitive?: boolean;
}

/**
 * The controls a live tab exposes. Implementations are registered per tab
 * id, so `tabId` is the identity the whole app already uses (layout, URL,
 * hotkeys) rather than a per-type id.
 */
export interface TabController {
  readonly tabId: string;
  readonly kind: TabKind;
  /**
   * Move keyboard focus into the tab's primary surface. Returns whether
   * focus was taken — `false` leaves a `when-mounted` intent retrying.
   */
  focus(options?: TabFocusOptions): boolean;
  /** Whether this tab can hold keyboard focus at all. */
  isFocusable(): boolean;
  /** Text the user has selected inside this tab, if any. */
  selectedText(): string | undefined;
  /** Release resources; called when the tab leaves the layout. */
  dispose(): void;
  /**
   * Occurrences of `query` in this tab's own content (find-in-tab). Async
   * because the content lives behind whatever machinery that tab type
   * already uses — the platform adapter's file search for a document, the
   * stored transcript for an agent session.
   */
  search(query: string, options?: TabSearchOptions): Promise<SearchTarget[]>;
  /** Scroll a match from `search` into view and highlight it. */
  revealMatch(match: SearchTarget): boolean;
  /** Undo/redo inside the tab; absent when the tab type has no history. */
  history?: TabHistoryControls;
}

export interface TabHistoryControls {
  undo(): void;
  redo(): void;
}

/** Ambient tab focus loses to modals, menus and sidebar text entry. */
const TAB_FOCUS_PRIORITY = 70;

const controllers = new Map<string, TabController>();

export function registerTabController(controller: TabController): void {
  controllers.set(controller.tabId, controller);
}

export function unregisterTabController(tabId: string): void {
  controllers.delete(tabId);
}

/** The live controller for a tab, or undefined if its surface isn't up. */
export function getTabController(tabId: string): TabController | undefined {
  return controllers.get(tabId);
}

export function hasTabController(tabId: string): boolean {
  return controllers.has(tabId);
}

// ---------------------------------------------------------------------------
// Focus — routed through the arbiter so tabs compete with modals, menus and
// the sidebar on the same terms, whatever kind of tab they are.
// ---------------------------------------------------------------------------

let observedIntentId: string | null = null;
let observedResult = false;

focusArbiter.registerResolver("tab", (intent) => {
  if (intent.target.type !== "tab") return false;

  const controller = controllers.get(intent.target.tabId);
  if (!controller) return false;

  const result = controller.focus({
    caret: intent.target.caret,
    steal: intent.steal,
  });
  if (observedIntentId === intent.id) {
    observedResult = result;
  }
  return result;
});

/** Tell the arbiter which tab is active; only its intents are eligible. */
export function setActiveTab(tabId: string | null): void {
  focusArbiter.setActiveTab(tabId);
}

/** Suppress all tab focus for `durationMs`; calling again resets the timer. */
export function suppressTabFocus(durationMs = 300): void {
  focusArbiter.suppress("tab", durationMs);
}

export function requestTabFocus(
  tabId: string,
  options: {
    when?: FocusTiming;
    reason?: string;
    caret?: TabCaretPlacement;
    steal?: boolean;
  } = {},
): string {
  return focusArbiter.request({
    domain: "tab",
    target: { type: "tab", tabId, caret: options.caret },
    steal: options.steal,
    priority: TAB_FOCUS_PRIORITY,
    reason: options.reason ?? "tab-focus",
    when: options.when ?? "immediate",
  });
}

/**
 * Focus a tab now and report whether focus actually landed — the arbiter is
 * asynchronous by default, so this files an immediate intent and flushes it
 * synchronously to observe the outcome (callers like the sidebar's collapse
 * retry loop need the answer, not a promise of one).
 */
export function focusTab(tabId: string): boolean {
  if (!controllers.has(tabId)) return false;

  const intentId = requestTabFocus(tabId, {
    when: "immediate",
    reason: "focus-tab",
  });

  observedIntentId = intentId;
  observedResult = false;
  focusArbiter.flush();
  observedIntentId = null;

  return observedResult;
}

// ---------------------------------------------------------------------------
// The rest of the general surface. Each is a thin dispatch: no logic lives
// here, so a new tab type never has to be added to any of these.
// ---------------------------------------------------------------------------

export function isTabFocusable(tabId: string): boolean {
  return controllers.get(tabId)?.isFocusable() ?? false;
}

export function getTabSelectedText(tabId: string): string | undefined {
  return controllers.get(tabId)?.selectedText();
}

/**
 * Tear a tab's surface down when it leaves the layout. Unregisters first so
 * a controller that unregisters itself during `dispose` can't leave a
 * stale entry behind.
 */
export function disposeTab(tabId: string): void {
  const controller = controllers.get(tabId);
  if (!controller) return;
  controllers.delete(tabId);
  controller.dispose();
}

export async function searchTab(
  tabId: string,
  query: string,
  options?: TabSearchOptions,
): Promise<SearchTarget[]> {
  return (await controllers.get(tabId)?.search(query, options)) ?? [];
}

export function revealTabMatch(tabId: string, match: SearchTarget): boolean {
  return controllers.get(tabId)?.revealMatch(match) ?? false;
}

export function runTabHistoryAction(
  tabId: string,
  action: "undo" | "redo",
): void {
  const history = controllers.get(tabId)?.history;
  if (!history) return;
  if (action === "undo") history.undo();
  else history.redo();
}
