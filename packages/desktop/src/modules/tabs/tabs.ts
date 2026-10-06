/**
 * Tabs entity — the dockable tab layout, its id conventions, and the handle
 * over one open tab.
 *
 * The layout itself is the `layout` module (`modules/layout/layout.ts`); this one
 * owns what happens to tabs in it:
 *   - `tabsModule` — `core.tabs`: open, select, focus, close, reveal a
 *     location in and rename a tab, and which tab is active. The only way
 *     the app changes tabs; the rename-open-tab bookkeeping is its state;
 *   - the open-tabs cross-entity join (`useWorkspaceTabs`);
 *   - `tab(tabId)` — the handle: the controls every tab type has, plus
 *     `.editor` on a file tab and `.agent` on an agent tab for the ones only
 *     that kind has;
 *   - re-exports of the two leaves it is the public face of: the pure layout
 *     codec (`utils/layout-codec`, shared with the crash-fallback debug
 *     panel) and the tab-id scheme (`tabs/tab-id`).
 */
import { defineModule } from "@notefig/core";
import type { LayoutNode } from "@/components/dockable";
import {
  LAYOUT_PARAM,
  parseLayout,
  extractTabIds,
  findLayoutSelectedTab,
} from "@/utils/layout-codec";
import {
  findFirstWindow,
  findWindowById,
  openFileInLayout,
  removeTabFromLayout,
  renameTabInLayout,
  selectTabInLayout,
  type OpenFileIntent,
} from "@/utils/dockable-layout";
import type { LayoutApi } from "@/modules/layout";
import type { FocusTiming } from "@/utils/focus-arbiter";
import {
  AGENT_TAB_PREFIX,
  RELEASE_NOTES_TAB_ID,
  agentTabId,
  agentTaskIdFromTabId,
  isAgentTabId,
  isFileTabId,
  isReleaseNotesTabId,
  parseTabId,
  tabKind,
  type TabKind,
  type TabRef,
} from "@/modules/tabs/tab-id";
import {
  disposeTab,
  focusTab,
  getTabController,
  getTabSelectedText,
  grantTabFocusHandoff,
  isTabFocusable,
  requestTabFocus,
  revealTabMatch,
  searchTab,
  type TabSearchMatch,
  type TabSearchOptions,
} from "@/modules/tabs/tab-controllers";
// Sibling entities — only referenced inside function bodies (cycle rule).
import type { EditorHandle, EditorsApi, EditorTarget } from "@/modules/editors";
import type { DocumentsApi } from "@/modules/documents";
import type { AgentsApi, AgentTaskHandle } from "@/modules/agents/agents";
import { type WorkspaceFiles } from "@/modules/files";
import {
  flushDocumentSync,
  whenDocumentSyncClean,
} from "@/utils/markdown-conversion";

// ---------------------------------------------------------------------------
// Public re-exports: the layout codec and the tab-id scheme.
// ---------------------------------------------------------------------------

export {
  LAYOUT_PARAM,
  parseLayout,
  extractTabIds,
  findLayoutSelectedTab,
  AGENT_TAB_PREFIX,
  RELEASE_NOTES_TAB_ID,
  agentTabId,
  agentTaskIdFromTabId,
  isAgentTabId,
  isFileTabId,
  isReleaseNotesTabId,
  parseTabId,
  tabKind,
};
export type { TabKind, TabRef, TabSearchMatch };

// ---------------------------------------------------------------------------
// The tab handle — general controls flat, type-specific ones behind `.editor`
// / `.agent`. Handles are re-resolved on every call and never cache state.
// ---------------------------------------------------------------------------

/** What every tab can do, whatever it contains. */
interface TabHandleBase {
  readonly tabId: string;
  /** Whether the tab's surface is live (mounted / instantiated). */
  isMounted(): boolean;
  isFocusable(): boolean;
  /** Move keyboard focus into the tab. Returns whether focus landed. */
  focus(): boolean;
  /** Text the user has selected inside the tab, if any. */
  selectedText(): string | undefined;
  /** Find-in-tab: occurrences of `query` in this tab's own content. */
  search(query: string, options?: TabSearchOptions): Promise<TabSearchMatch[]>;
  /** Scroll a match from `search` into view; resolves whether it moved. */
  revealMatch(match: TabSearchMatch): Promise<boolean>;
}

export interface FileTabHandle extends TabHandleBase {
  readonly kind: "file";
  readonly path: string;
  /** The document controls only a file tab has (dirty state, markdown). */
  readonly editor: EditorHandle;
}

export interface AgentTabHandle extends TabHandleBase {
  readonly kind: "agent";
  readonly taskId: string;
  /** The session controls only an agent tab has (prompt, cancel, auth). */
  readonly agent: AgentTaskHandle;
}

export interface ReleaseNotesTabHandle extends TabHandleBase {
  readonly kind: "release-notes";
}

export type TabHandle = FileTabHandle | AgentTabHandle | ReleaseNotesTabHandle;

/**
 * The handle over one open tab, whether or not it is currently mounted (an
 * unmounted tab reports `isMounted() === false` and its controls no-op).
 * A file tab's half comes from `editors` (`core.editors`), an agent tab's
 * from `agents` (`core.agents`).
 */
export function tab(
  tabId: string,
  {
    agents,
    editors,
  }: { agents: Pick<AgentsApi, "task">; editors: Pick<EditorsApi, "get"> },
): TabHandle {
  const base: TabHandleBase = {
    tabId,
    isMounted: () => getTabController(tabId) !== undefined,
    isFocusable: () => isTabFocusable(tabId),
    focus: () => focusTab(tabId),
    selectedText: () => getTabSelectedText(tabId),
    search: (query, options) => searchTab(tabId, query, options),
    revealMatch: (match) => revealTabMatch(tabId, match),
  };

  const ref = parseTabId(tabId);
  switch (ref.kind) {
    case "file":
      return {
        ...base,
        kind: "file",
        path: ref.path,
        editor: editors.get(ref.path),
      };
    case "agent":
      return {
        ...base,
        kind: "agent",
        taskId: ref.taskId,
        agent: agents.task(ref.taskId),
      };
    case "release-notes":
      return { ...base, kind: "release-notes" };
  }
}

// ---------------------------------------------------------------------------
// core.tabs — the one way the app changes tabs.
// ---------------------------------------------------------------------------

type DockWindow = NonNullable<ReturnType<typeof findFirstWindow>>;

export interface OpenTabOptions {
  /** "replace" swaps out the target window's selected tab (default). */
  intent?: OpenFileIntent;
  /** Defaults to the active window. */
  targetWindowId?: string;
  /**
   * When the tab is already open in another window than `targetWindowId`,
   * move it there instead of selecting it in place. Only explicit placement
   * gestures (a drop onto a window) set this.
   */
  moveIfOpen?: boolean;
  /**
   * The gesture opened this tab as the thing to type into next (a created
   * file whose tree field is still open): its next focus claim may take
   * focus out of a live text entry. One-shot.
   */
  handoff?: boolean;
  /**
   * Change other search params in the same navigation, for a write that
   * must land atomically with the open (closing the settings modal as a
   * tab opens from it).
   */
  params?: (params: URLSearchParams) => void;
}

export interface TabFocusRequest {
  /**
   * "now" (default) focuses synchronously and reports whether it landed.
   * The arbiter's timings file an intent instead ("when-mounted" keeps it
   * until the tab's surface is up) and return false.
   */
  when?: "now" | FocusTiming;
  /** An explicit user hand-off; ambient claims never steal focus. */
  steal?: boolean;
  reason?: string;
}

export interface TabsApi {
  /**
   * Open a tab, or select it if it is open. Returns false for a file the
   * editor cannot open. A tab the open replaces is disposed.
   */
  open(tabId: string, options?: OpenTabOptions): boolean;
  /** Open (or select) an agent session's chat tab, always as a new tab. */
  openAgent(taskId: string): void;
  /** Make an open tab its window's selected tab. */
  select(tabId: string): void;
  /** Move keyboard focus into a tab. */
  focus(tabId: string, request?: TabFocusRequest): boolean;
  close(tabId: string): void;
  /**
   * Open the file as a tab (or select it) and move its editor to `target`
   * once it is mounted. False when the file cannot be opened or the
   * location is not found.
   */
  reveal(
    filePath: string,
    target: EditorTarget,
    options?: OpenTabOptions,
  ): Promise<boolean>;
  /** Swap a tab id in place, without disposing (rename-open-tab flow). */
  rename(oldId: string, newId: string): void;
  /**
   * Rename/move an OPEN file tab by closing and reopening it in place: the
   * editor is disposed, the file moved once the save pipeline drains, and
   * the tab id swapped in the layout without leaving its window slot. The
   * editor remounts at the new path (undo history and caret are not
   * preserved — accepted for an explicit rename/promote gesture). Throws if
   * the move fails; the tab is left intact at the old path in that case.
   */
  renameOpenFile(options: {
    /** The files of the workspace that holds the file. */
    files: Pick<WorkspaceFiles, "file">;
    oldPath: string;
    newPath: string;
  }): Promise<void>;
  /**
   * Tab ids mid-rename (old → new). Between the collection row re-key and
   * the layout id-swap commit, the layout briefly holds an id with no
   * backing row; the stale-tab pruning must not close it. An entry ends
   * from state truth — once the layout no longer holds the old id.
   */
  renaming(): ReadonlyMap<string, string>;
  /** Take a layout the dock produced (drag, close), disposing removed tabs. */
  applyLayout(next: LayoutNode[]): void;
  /** The selected tab of the active window. */
  activeTabId(): string | null;
  activeWindowId(): string | null;
  /** The active window's tabs, in order. */
  activeWindowTabs(): string[];
  /** Called when the layout or the focused window changes. */
  subscribe(listener: () => void): () => void;
}

declare module "@notefig/core" {
  interface CoreModules {
    tabs: TabsApi;
  }
}

const WINDOW_ID_ATTRIBUTE = "data-dockable-window-id";

function windowIdOf(element: Element | null): string | null {
  return (
    element?.closest<HTMLElement>(`[${WINDOW_ID_ATTRIBUTE}]`)?.dataset
      .dockableWindowId ?? null
  );
}

/** The dock window that last held focus, kept after focus leaves the dock. */
function createFocusedWindow() {
  let windowId: string | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => windowId,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    track(): () => void {
      const onFocusIn = (event: FocusEvent) => {
        const next = windowIdOf(event.target as Element | null);
        if (!next || next === windowId) return;
        windowId = next;
        for (const listener of [...listeners]) listener();
      };
      document.addEventListener("focusin", onFocusIn);
      return () => document.removeEventListener("focusin", onFocusIn);
    },
  };
}

/** What tabs are built from. */
export interface TabsDeps {
  layout: LayoutApi;
  focusedWindow: Pick<
    ReturnType<typeof createFocusedWindow>,
    "get" | "subscribe"
  >;
  /** The editor's format gate. */
  canOpenFile: (path: string) => boolean;
  editors: Pick<EditorsApi, "goTo" | "markdownEditor">;
  /** Writes in flight on a path being renamed, and where they land after. */
  documents: Pick<DocumentsApi, "whenWritesSettled" | "beginMove">;
}

export function createTabs({
  layout,
  focusedWindow,
  canOpenFile,
  editors,
  documents,
}: TabsDeps): TabsApi {
  const renaming = new Map<string, string>();
  /** Watching the layout for the moment a renamed-away id leaves it; only
   *  while a rename is pending. */
  let stopWatchingRenames: (() => void) | null = null;
  const endSettledRenames = () => {
    const ids = layout.openTabIds();
    for (const oldId of renaming.keys()) {
      if (!ids.includes(oldId)) renaming.delete(oldId);
    }
    if (renaming.size === 0 && stopWatchingRenames) {
      stopWatchingRenames();
      stopWatchingRenames = null;
    }
  };
  const beginRename = (oldId: string, newId: string) => {
    renaming.set(oldId, newId);
    stopWatchingRenames ??= layout.subscribe(endSettledRenames);
  };
  const endRename = (oldId: string) => {
    renaming.delete(oldId);
    endSettledRenames();
  };

  /** Focus inside the dock first, then the window that last had it, then
   *  the layout's selection, then the first window. */
  const activeWindow = (): DockWindow | null => {
    const current = layout.read();
    const focusedNow = windowIdOf(document.activeElement);
    if (focusedNow) {
      const window = findWindowById(current, focusedNow);
      if (window) return window;
    }
    const remembered = focusedWindow.get();
    if (remembered) {
      const window = findWindowById(current, remembered);
      if (window) return window;
    }
    const selected = layout.selectedTabId();
    if (selected) {
      const window = current.find(
        (node) => "selected" in node && node.selected === selected,
      );
      if (window && "selected" in window) return window as DockWindow;
    }
    return findFirstWindow(current);
  };

  const tabs: TabsApi = {
    open(tabId, options = {}) {
      // Only file tabs are gated on the editor's format support; the other
      // tab kinds carry their own content.
      if (tabKind(tabId) === "file" && !canOpenFile(tabId)) return false;
      const targetWindowId =
        options.targetWindowId ?? activeWindow()?.id ?? undefined;
      layout.update(
        (current) => {
          const next = openFileInLayout(current, {
            tabId,
            intent: options.intent ?? "replace",
            targetWindowId,
            moveIfOpen: options.moveIfOpen,
          });
          // "replace" drops the target window's selected tab, and a tab that
          // leaves the layout must be disposed. disposeTab is idempotent.
          const nextIds = extractTabIds(next);
          for (const id of extractTabIds(current)) {
            if (!nextIds.includes(id)) disposeTab(id);
          }
          return next;
        },
        { params: options.params },
      );
      if (options.handoff) grantTabFocusHandoff(tabId);
      return true;
    },
    openAgent(taskId) {
      // A session must never replace the file tab in view.
      tabs.open(agentTabId(taskId), { intent: "new-tab" });
    },
    select(tabId) {
      if (!layout.openTabIds().includes(tabId)) return;
      layout.update((current) => selectTabInLayout(current, tabId));
    },
    focus(tabId, request = {}) {
      const when = request.when ?? "now";
      if (when === "now") return focusTab(tabId);
      requestTabFocus(tabId, {
        when,
        reason: request.reason,
        steal: request.steal,
      });
      return false;
    },
    close(tabId) {
      if (!layout.openTabIds().includes(tabId)) return;
      disposeTab(tabId);
      layout.update((current) => removeTabFromLayout(current, tabId));
    },
    async reveal(filePath, target, options) {
      if (!tabs.open(filePath, options)) return false;
      return editors.goTo(filePath, target);
    },
    rename(oldId, newId) {
      layout.update((current) => renameTabInLayout(current, oldId, newId));
    },
    async renameOpenFile({ files, oldPath, newPath }) {
      // One rename per source path at a time: the coordination entries are
      // keyed by oldPath, so a second overlapping call would overwrite the
      // first's, and whichever fails would clear the other's write redirect
      // and stale-prune guard mid-swap.
      if (renaming.has(oldPath)) {
        throw new Error(`A rename of "${oldPath}" is already in progress`);
      }
      beginRename(oldPath, newPath);
      const move = documents.beginMove(oldPath);
      // Freeze the editor for the duration: an edit landing after the drain
      // would schedule a save against the old path and resurrect it
      // post-move. The editor stays alive (read-only) until the move
      // succeeds, so a failed move leaves the tab fully intact.
      const liveEditor = editors.markdownEditor(oldPath);
      liveEditor?.setEditable(false);
      try {
        flushDocumentSync(oldPath);
        await whenDocumentSyncClean(oldPath);
        // Writes that passed the redirect check before this rename began
        // are tracked in flight — drain them too before moving the file.
        await documents.whenWritesSettled(oldPath);
        await files.file(oldPath).rename(newPath);
      } catch (error) {
        if (liveEditor && !liveEditor.isDestroyed) liveEditor.setEditable(true);
        move.settle(oldPath);
        endRename(oldPath);
        throw error;
      }
      move.settle(newPath);
      disposeTab(oldPath);
      tabs.rename(oldPath, newPath);
      // The guard clears from state truth, not a timer: the layout
      // subscription ends the rename once the layout no longer holds the
      // old id (swap committed or tab closed). A timer raced the
      // URL-driven layout commit — a prune render holding the pre-swap
      // layout could clobber the swap.
    },
    renaming: () => renaming,
    applyLayout(next) {
      const nextIds = extractTabIds(next);
      for (const id of layout.openTabIds()) {
        if (!nextIds.includes(id)) disposeTab(id);
      }
      layout.update(next);
    },
    activeTabId: () => activeWindow()?.selected ?? layout.selectedTabId(),
    activeWindowId: () => activeWindow()?.id ?? null,
    activeWindowTabs: () => activeWindow()?.children ?? [],
    subscribe(listener) {
      const offLayout = layout.subscribe(listener);
      const offFocus = focusedWindow.subscribe(listener);
      return () => {
        offLayout();
        offFocus();
      };
    },
  };
  return tabs;
}

/**
 * `canOpenFile` is the editor's format gate. It is passed in by the
 * composition root so this entity does not import editor components.
 */
export function tabsModule({
  canOpenFile,
}: {
  canOpenFile: (path: string) => boolean;
}) {
  const focusedWindow = createFocusedWindow();
  return defineModule({
    name: "tabs",
    needs: ["layout", "editors", "documents"],
    register: (ctx) =>
      createTabs({
        layout: ctx.use("layout"),
        focusedWindow,
        canOpenFile,
        editors: ctx.use("editors"),
        documents: ctx.use("documents"),
      }),
    boot: () => focusedWindow.track(),
  });
}
