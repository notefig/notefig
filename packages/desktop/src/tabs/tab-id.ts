/**
 * Tab id scheme — the one module that knows how a dockable tab id encodes
 * what the tab shows.
 *
 * Tab ids are workspace file paths by default; a known scheme prefix marks
 * a non-file tab (file paths are absolute, so they can never collide with a
 * scheme). Keeping the encoding here — a leaf with no imports — lets the
 * controller registry, the render registry and the entity layer all agree on
 * a tab's kind without importing each other.
 *
 * Adding a tab type starts here: give it a scheme, add its `TabKind`, and
 * teach `parseTabId` about it. The type checker then walks you through the
 * two registries (`tab-controllers.ts`, `tab-types.tsx`).
 */

export const AGENT_TAB_PREFIX = "agent:";

/** Singleton release-notes tab. */
export const RELEASE_NOTES_TAB_ID = "release:";

/** Every kind of tab the dock can show. */
export type TabKind = "file" | "agent" | "release-notes";

/** A tab id decoded into what it points at. */
export type TabRef =
  | { kind: "file"; tabId: string; path: string }
  | { kind: "agent"; tabId: string; taskId: string }
  | { kind: "release-notes"; tabId: string };

export function agentTabId(taskId: string): string {
  return `${AGENT_TAB_PREFIX}${taskId}`;
}

export function isAgentTabId(tabId: string): boolean {
  return tabId.startsWith(AGENT_TAB_PREFIX);
}

export function agentTaskIdFromTabId(tabId: string): string | null {
  return isAgentTabId(tabId) ? tabId.slice(AGENT_TAB_PREFIX.length) : null;
}

export function isReleaseNotesTabId(tabId: string): boolean {
  return tabId === RELEASE_NOTES_TAB_ID;
}

/** The single place that decodes the tab-id encoding. */
export function parseTabId(tabId: string): TabRef {
  if (isReleaseNotesTabId(tabId)) {
    return { kind: "release-notes", tabId };
  }
  const taskId = agentTaskIdFromTabId(tabId);
  if (taskId !== null) {
    return { kind: "agent", tabId, taskId };
  }
  return { kind: "file", tabId, path: tabId };
}

export function tabKind(tabId: string): TabKind {
  return parseTabId(tabId).kind;
}

export function isFileTabId(tabId: string): boolean {
  return tabKind(tabId) === "file";
}
