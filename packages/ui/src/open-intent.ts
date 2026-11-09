import { ArrowUpRight } from "lucide-react";

/**
 * Where a link to a document, scratchpad, prompt or session opens: in place
 * of the tab in front ("replace") or as a tab of its own beside it
 * ("new-tab"). The one gesture every list and link in the app follows, so
 * the file tree, the Everything view, the sessions panel and the links in
 * agent output all open things the same way.
 */
export type OpenIntent = "replace" | "new-tab";

/**
 * The intent a click asks for: Mod (⌘ on macOS, Ctrl elsewhere) opens a
 * new tab, a plain click replaces.
 */
export function openIntentOf(
  event: Pick<MouseEvent, "metaKey" | "ctrlKey">,
): OpenIntent {
  return event.metaKey || event.ctrlKey ? "new-tab" : "replace";
}

/** The glyph of every "Open in New Tab" menu item. */
export const OpenInNewTabIcon = ArrowUpRight;
