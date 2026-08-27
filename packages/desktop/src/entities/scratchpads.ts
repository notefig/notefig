/**
 * Scratchpads entity (MET-135): where nameless new files live. "New File"
 * instantly creates the next untitled markdown file in the app-owned
 * `.metrists/scratchpads/` folder; membership in that folder — not the
 * filename — is what makes a file a scratchpad. Scratchpads never reach the
 * user's git (the existing `.metrists/` exclude covers them) but ARE
 * checkpointed by the app's history repo, whose own exclude history-service
 * narrows accordingly. Moving a file out of the folder is how it becomes a
 * tracked project file. MET-115 renames `.metrists`; consumers derive every
 * path from the constants here.
 *
 * This file is the whole feature: path scheme + naming, lifecycle I/O
 * (create / entry resolution / sweep / close-time GC and auto-rename), and
 * the empty-entry hook.
 */
import { useEffect, useRef } from "react";
import { platformAdapter } from "@/adapters";
import { path as pathutil } from "@/utils/path";
import {
  flushDocumentSync,
  whenDocumentSyncClean,
} from "@/utils/markdown-conversion";
import type { OpenFileInLayoutOptions } from "@/utils/dockable-layout";
import {
  createFile,
  deleteFileOrDirectory,
  getOrCreateWorkspaceCollections,
  renameFileOrDirectory,
  useMetadataReady,
  type FileMetadata,
} from "./files";
import { useAgentTasksReady } from "./agents";

// ---------------------------------------------------------------------------
// Path scheme & naming (pure)
// ---------------------------------------------------------------------------

export const APP_DIR_NAME = ".metrists";
export const SCRATCHPADS_DIR_NAME = "scratchpads";
export const SCRATCHPADS_REL_PATH = `${APP_DIR_NAME}/${SCRATCHPADS_DIR_NAME}`;
export const UNTITLED_BASENAME = "untitled";

export function appDirPath(workspacePath: string): string {
  return pathutil.join(workspacePath, APP_DIR_NAME);
}

export function scratchpadsDirPath(workspacePath: string): string {
  return pathutil.join(appDirPath(workspacePath), SCRATCHPADS_DIR_NAME);
}

/** Scratchpad = a file DIRECTLY in the folder, whatever its name. */
export function isScratchpadFileRow(row: {
  relativePath?: string;
  type: string;
}): boolean {
  if (row.type !== "file" || row.relativePath === undefined) return false;
  const prefix = `${SCRATCHPADS_REL_PATH}/`;
  return (
    row.relativePath.startsWith(prefix) &&
    !row.relativePath.slice(prefix.length).includes("/")
  );
}

export function isScratchpadPath(
  workspacePath: string,
  absolutePath: string,
): boolean {
  return pathutil.dirname(absolutePath) === scratchpadsDirPath(workspacePath);
}

export function isUntitledBasename(basename: string): boolean {
  return new RegExp(`^${UNTITLED_BASENAME}(-\\d+)?\\.md$`, "i").test(basename);
}

export function nextUntitledBasename(existingBasenames: string[]): string {
  const taken = new Set(existingBasenames);
  let name = `${UNTITLED_BASENAME}.md`;
  let counter = 2;
  while (taken.has(name)) {
    name = `${UNTITLED_BASENAME}-${counter}.md`;
    counter += 1;
  }
  return name;
}

/** Most recent by mtime; ties/missing stats fall back to basename compare
 * so the answer stays deterministic (stats hydrate lazily). */
export function pickMostRecentScratchpad(
  candidates: { path: string; modifiedAt?: Date }[],
): string {
  let best = candidates[0];
  for (const candidate of candidates.slice(1)) {
    const bestTime = best.modifiedAt?.getTime() ?? 0;
    const candidateTime = candidate.modifiedAt?.getTime() ?? 0;
    if (
      candidateTime > bestTime ||
      (candidateTime === bestTime &&
        pathutil
          .basename(candidate.path)
          .localeCompare(pathutil.basename(best.path)) > 0)
    ) {
      best = candidate;
    }
  }
  return best.path;
}

/** Text of the document's first ATX heading; tolerates content that hasn't
 * loaded yet. */
export function deriveScratchpadTitle(
  markdown: string | null | undefined,
): string | null {
  if (typeof markdown !== "string" || markdown.length === 0) return null;
  const match = markdown.match(/^#{1,6}\s+(.+?)\s*#*\s*$/m);
  const title = match?.[1]?.trim();
  return title ? title : null;
}

const MAX_SLUG_LENGTH = 32;

/** `# Plans: Q3/Q4` → `plans-q3-q4`; null when nothing survives. */
export function slugifyScratchpadTitle(title: string): string | null {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/, "");
  return slug ? slug : null;
}

/** Random tail for auto-derived names (`plans-q3-q4-k3f9.md`) — unique
 * without counter churn. */
export function randomScratchpadSuffix(): string {
  return Math.random().toString(36).slice(2, 6).padEnd(4, "0");
}

/** Tree paths the user must not rename, delete, or drag — the app dir and
 * the scratchpads folder themselves. Files inside stay editable. */
export function isProtectedTreePath(relativeTreePath: string): boolean {
  return (
    relativeTreePath === APP_DIR_NAME ||
    relativeTreePath === SCRATCHPADS_REL_PATH
  );
}

/** Content-derived display title for a scratchpad tab; null falls back to
 * the filename. Display only — the file renames at close time. */
export function scratchpadTabTitle(
  workspacePath: string,
  row: {
    path: string;
    isContentLoaded?: boolean;
    contentError?: string;
    content?: string;
  },
): string | null {
  if (!isScratchpadPath(workspacePath, row.path)) return null;
  if (!row.isContentLoaded || row.contentError) return null;
  return deriveScratchpadTitle(row.content);
}

// ---------------------------------------------------------------------------
// Lifecycle I/O
// ---------------------------------------------------------------------------

/** Best-effort removal of the pre-MET-135 `.metrists/agent/` config dir —
 * it predates the app dir becoming visible in the tree; new configs live
 * in dot-named `.metrists/.agent/`. */
export function cleanupLegacyAgentConfigDir(workspacePath: string): void {
  void platformAdapter.fs
    .deleteDirectories([pathutil.join(appDirPath(workspacePath), "agent")], {
      recursive: true,
    })
    .catch(() => {});
}

function scratchpadRows(workspacePath: string): FileMetadata[] {
  return getOrCreateWorkspaceCollections(workspacePath).metadata.toArray.filter(
    (row) => isScratchpadFileRow(row),
  );
}

/** A file squatting on a path we need as a directory disables the feature. */
function scratchpadDirIsBlocked(workspacePath: string): boolean {
  const metadata = getOrCreateWorkspaceCollections(workspacePath).metadata;
  const dir = scratchpadsDirPath(workspacePath);
  return [dir, pathutil.dirname(dir)].some(
    (candidate) => metadata.get(candidate)?.type === "file",
  );
}

/** "New File": create the next untitled scratchpad, return its path. Never
 * targets an existing path — the create path truncates. */
export async function createUntitledScratchpad(
  workspacePath: string,
): Promise<string> {
  if (scratchpadDirIsBlocked(workspacePath)) {
    throw new Error("a file occupies the scratchpads directory path");
  }
  const basenames = scratchpadRows(workspacePath).map((row) =>
    pathutil.basename(row.path),
  );
  const filePath = pathutil.join(
    scratchpadsDirPath(workspacePath),
    nextUntitledBasename(basenames),
  );
  await createFile(workspacePath, filePath);
  return filePath;
}

/** The "New File" action: create the next untitled scratchpad and open it
 * as a tab. Shared by the Mod+N command, the palette, and the sidebar. */
export function createAndOpenScratchpad(
  workspacePath: string,
  openFile: (options: OpenFileInLayoutOptions) => boolean,
): void {
  void createUntitledScratchpad(workspacePath)
    .then((path) => openFile({ tabId: path, intent: "new-tab" }))
    .catch((error) => console.error("Failed to create a new file:", error));
}

/** What an empty workspace entry should open: the most recently modified
 * scratchpad, else a fresh untitled one. Null bails to the empty state. */
export async function resolveScratchpadToOpen(
  workspacePath: string,
): Promise<string | null> {
  if (scratchpadDirIsBlocked(workspacePath)) {
    console.warn(
      "[scratchpads] a file occupies the scratchpads directory path; skipping",
    );
    return null;
  }

  const candidates = scratchpadRows(workspacePath);
  if (candidates.length === 0) {
    return createUntitledScratchpad(workspacePath);
  }
  const stats = await platformAdapter.fs.getMetadata(
    candidates.map((row) => row.path),
  );
  const modifiedByPath = new Map(
    stats.succeeded.map((m) => [m.path, m.modifiedAt]),
  );
  return pickMostRecentScratchpad(
    candidates.map((row) => ({
      path: row.path,
      modifiedAt: modifiedByPath.get(row.path) ?? row.modified,
    })),
  );
}

/** Entry-time sweep over scratchpads not open in a tab (and not `keepPath`):
 * whitespace-only leftovers are deleted, untitled ones with content pick up
 * their derived name. Best-effort; failures warn, never throw. */
export async function sweepEmptyScratchpads(
  workspacePath: string,
  keepPath: string | null,
  openTabIds: string[],
): Promise<void> {
  const open = new Set(openTabIds);
  const candidates = scratchpadRows(workspacePath)
    .map((row) => row.path)
    .filter((path) => path !== keepPath && !open.has(path));
  if (candidates.length === 0) return;

  const reads = await platformAdapter.fs.readFiles(candidates);
  for (const { path, content } of reads.succeeded) {
    try {
      if (content.trim() === "") {
        await deleteFileOrDirectory(workspacePath, path);
      } else {
        await maybeAutoRenameScratchpad(workspacePath, path, content);
      }
    } catch (error) {
      console.warn(`[scratchpads] failed to sweep '${path}':`, error);
    }
  }
}

/** Rename an untitled scratchpad to `<slug>-<random>.md`. No-op for named
 * files or headingless content. Callers guarantee the tab is not open. */
async function maybeAutoRenameScratchpad(
  workspacePath: string,
  path: string,
  content: string,
): Promise<void> {
  if (!isUntitledBasename(pathutil.basename(path))) return;
  const title = deriveScratchpadTitle(content);
  const slug = title ? slugifyScratchpadTitle(title) : null;
  if (!slug) return;

  const metadata = getOrCreateWorkspaceCollections(workspacePath).metadata;
  const dir = scratchpadsDirPath(workspacePath);
  let target = pathutil.join(dir, `${slug}-${randomScratchpadSuffix()}.md`);
  for (let i = 0; i < 3 && metadata.get(target) !== undefined; i++) {
    target = pathutil.join(dir, `${slug}-${randomScratchpadSuffix()}.md`);
  }
  await renameFileOrDirectory(workspacePath, path, target);
}

/**
 * Close-time lifecycle for a scratchpad tab. MUST run before the tab's
 * dispose so the document sync is still alive for the flush; the clean
 * promise is captured before dispose and still resolves when the final
 * write lands. Whitespace-only → delete; untitled + heading → auto-rename.
 * Failures warn and never block the close.
 */
export function maybeGcScratchpadOnClose(
  workspacePath: string,
  tabId: string,
): void {
  if (!isScratchpadPath(workspacePath, tabId)) return;

  flushDocumentSync(tabId);
  const clean = whenDocumentSyncClean(tabId);

  void clean.then(async () => {
    try {
      // Rows lead disk, so a loaded content row is authoritative; an
      // unloaded one means the file was never opened — read the disk.
      const row = getOrCreateWorkspaceCollections(workspacePath).content.get(
        tabId,
      );
      const content =
        row && row.error === undefined
          ? row.content
          : ((await platformAdapter.fs.readFiles([tabId])).succeeded[0]
              ?.content ?? null);
      if (content === null) return;

      if (content.trim() === "") {
        await deleteFileOrDirectory(workspacePath, tabId);
        return;
      }

      await maybeAutoRenameScratchpad(workspacePath, tabId, content);
    } catch (error) {
      console.warn(`[scratchpads] close-time gc failed for '${tabId}':`, error);
    }
  });
}

// ---------------------------------------------------------------------------
// Empty-entry hook
// ---------------------------------------------------------------------------

/**
 * Lands an empty workspace entry in a scratchpad instead of the "No file
 * selected" screen. Decides exactly once per entry, after the saved-URL
 * restore settled, metadata + agent tasks loaded, and stale tabs pruned —
 * so an only-stale layout counts as empty, while closing the last tab
 * mid-session never re-summons anything. Non-empty entries still get the
 * leftover sweep.
 */
export function useScratchpadOnEmptyOpen(options: {
  workspacePath: string;
  openTabs: string[];
  staleTabIds: string[];
  isEntrySettled: boolean;
  openFile: (options: OpenFileInLayoutOptions) => boolean;
}): void {
  const { workspacePath, openTabs, staleTabIds, isEntrySettled, openFile } =
    options;
  const isMetadataReady = useMetadataReady(workspacePath);
  const areAgentTasksReady = useAgentTasksReady();
  const decidedForRef = useRef<string | null>(null);
  const inFlightRef = useRef(false);

  useEffect(() => {
    if (decidedForRef.current === workspacePath || inFlightRef.current) return;
    if (!isEntrySettled || !isMetadataReady || !areAgentTasksReady) return;
    if (staleTabIds.length > 0) return;

    cleanupLegacyAgentConfigDir(workspacePath);

    if (openTabs.length > 0) {
      decidedForRef.current = workspacePath;
      void sweepEmptyScratchpads(workspacePath, null, openTabs).catch(
        (error) => console.warn("[scratchpads] entry sweep failed:", error),
      );
      return;
    }

    inFlightRef.current = true;
    void resolveScratchpadToOpen(workspacePath)
      .then((path) => {
        decidedForRef.current = workspacePath;
        if (!path) return;
        openFile({ tabId: path, intent: "new-tab" });
        return sweepEmptyScratchpads(workspacePath, path, [path]);
      })
      .catch((error) => {
        decidedForRef.current = workspacePath;
        console.warn("[scratchpads] failed to open a scratchpad:", error);
      })
      .finally(() => {
        inFlightRef.current = false;
      });
  }, [
    workspacePath,
    openTabs,
    staleTabIds,
    isEntrySettled,
    isMetadataReady,
    areAgentTasksReady,
    openFile,
  ]);
}
