/**
 * The agent chat tab's side of the tab-controller contract — the agent
 * counterpart of what `editor-store.ts` registers for a document tab.
 *
 * The chat tab has no long-lived instance store: the dock unmounts every
 * unselected tab, so the controller is registered by the mounted tab and
 * dropped on unmount. That is the right lifetime — an unmounted chat tab
 * genuinely cannot take focus, and a `when-mounted` focus intent should keep
 * waiting until it is back (the session itself lives on in the agent
 * collections either way, which is why `dispose` deliberately does nothing:
 * closing a tab must never cancel a session).
 */
import { useEffect, useRef } from "react";
import { isTextEntryActive } from "@/utils/focus-arbiter";
import {
  registerTabController,
  unregisterTabController,
  type TabController,
  type TabFocusOptions,
  type TabSearchMatch,
  type TabSearchOptions,
} from "@/tabs/tab-controllers";
import { agentTabId } from "@/tabs/tab-id";

/** A live element reference; `RefObject`-compatible in both React typings. */
type ElementRef<T extends HTMLElement> = { readonly current: T | null };

/** A mutable box the composer fills in with its own focus call. */
export type ComposerFocusHandle = { focus: () => boolean };

export function createComposerFocusHandle(): ComposerFocusHandle {
  return { focus: () => false };
}

/**
 * The chat tab's primary surface is its composer: focusing the tab puts the
 * caret where the user types, the same way focusing a document tab puts it
 * in the document.
 */
function createAgentTabController(
  taskId: string,
  root: ElementRef<HTMLElement>,
  composer: ComposerFocusHandle,
): TabController {
  const tabId = agentTabId(taskId);

  return {
    tabId,
    kind: "agent",

    focus({ steal }: TabFocusOptions = {}): boolean {
      const element = root.current;
      if (!element) return false;

      const active = document.activeElement;
      // Already inside this tab — nothing to take.
      if (active instanceof HTMLElement && element.contains(active)) {
        return true;
      }
      // Same rule as a document tab: ambient intents (tab activation,
      // layout reclaim) never yank focus out of an active text entry
      // elsewhere; only an explicit hand-off may.
      if (!steal && isTextEntryActive(active)) return false;

      return composer.focus();
    },

    isFocusable: () => root.current !== null,

    /** The user's transcript selection, when it lies inside this tab. */
    selectedText(): string | undefined {
      const element = root.current;
      if (!element) return undefined;

      const selection = document.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
        return undefined;
      }
      const range = selection.getRangeAt(0);
      if (!element.contains(range.commonAncestorContainer)) return undefined;

      const text = selection.toString();
      return text.trim() ? text : undefined;
    },

    // Closing the tab leaves the session running; it stays reachable from
    // the sessions sidebar and re-opens with its transcript intact.
    dispose: () => {},

    // ── Find-in-transcript: not implemented yet (MET-152) ───────────────
    // Everything around it is wired: ⌘F routes here for an agent tab, and
    // whatever this returns is what the caller reveals. What is missing is
    // (1) matching `query` against the transcript entries — the rows are in
    // `agentEntriesForTask(taskId)`, and each match needs the same
    // {matchText, lineText, occurrence} shape a file match carries — and
    // (2) scrolling the matched row into view and highlighting the phrase
    // inside it (the transcript is virtualised, so revealing means asking
    // its virtualiser to scroll to the row's index first).
    search(_query: string, _options?: TabSearchOptions): TabSearchMatch[] {
      return [];
    },

    revealMatch(_match: TabSearchMatch): boolean {
      return false;
    },
  };
}

/**
 * Publish this chat tab's controls for as long as it is mounted. Returns the
 * root ref to spread on the tab's outermost element and the composer's focus
 * box to hand down to the prompt box.
 */
export function useAgentTabController(taskId: string) {
  const rootRef = useRef<HTMLDivElement>(null);
  const composerFocusRef = useRef<ComposerFocusHandle>(
    createComposerFocusHandle(),
  );

  useEffect(() => {
    registerTabController(
      createAgentTabController(taskId, rootRef, composerFocusRef.current),
    );
    return () => unregisterTabController(agentTabId(taskId));
  }, [taskId]);

  return { rootRef, composerFocusRef };
}
