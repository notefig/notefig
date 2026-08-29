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
 * This file is the whole feature, and the feature is deliberately small.
 * Scratchpads have exactly two special powers: "New File" auto-creates the
 * next untitled file here, and an empty workspace entry auto-opens the most
 * recent one (useNavigationPersistence folds it into the entry URL), after
 * an entry-time sweep deletes abandoned empty untitled ones (renamed files
 * are the user's, even while empty). The "scratchpad on
 * startup" app setting turns the empty-entry half off entirely — no
 * create, no auto-open; only the sweep still runs. In every other respect
 * — renaming, dragging, tab titles, deletion — they are ordinary files
 * with no special treatment. Entry lifecycle runs on plain adapter fs —
 * never on collections — so it cannot race collection or query readiness;
 * rows catch up via the normal metadata walk.
 */
import { platformAdapter } from "@/adapters";
import { path as pathutil } from "@/utils/path";
import type { OpenFileInLayoutOptions } from "@/utils/dockable-layout";
import {
  createFile,
  getOrCreateWorkspaceCollections,
  type FileMetadata,
} from "./files";

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

/** A basename this module itself would generate ("untitled.md",
 * "untitled-2.md", …). Anything else carries a user-chosen name. */
export function isUntitledBasename(basename: string): boolean {
  return new RegExp(`^${UNTITLED_BASENAME}(-\\d+)?\\.md$`).test(basename);
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

/** Tree paths the user must not rename, delete, or drag — the app dir and
 * the scratchpads folder themselves. Files inside stay editable. */
export function isProtectedTreePath(relativeTreePath: string): boolean {
  return (
    relativeTreePath === APP_DIR_NAME ||
    relativeTreePath === SCRATCHPADS_REL_PATH
  );
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

/**
 * Entry-time resolution, on plain disk truth: the most recently modified
 * scratchpad, else a freshly created untitled one. Null bails to the
 * empty state (e.g. a file squatting on the folder path).
 */
export async function resolveScratchpadOnDisk(
  workspacePath: string,
): Promise<string | null> {
  const dir = scratchpadsDirPath(workspacePath);
  const listing = await platformAdapter.fs.readDirectory(dir, {
    recursive: false,
    includeFiles: true,
    includeDirectories: false,
  });
  if (!listing.ok && listing.error.type !== "not_found") {
    console.warn("[scratchpads] cannot use the folder:", listing.error);
    return null;
  }
  const files = listing.ok ? listing.value : [];

  if (files.length === 0) {
    const fresh = pathutil.join(dir, nextUntitledBasename([]));
    const created = await platformAdapter.fs.createFiles([fresh]);
    if (created.failed.length > 0) {
      console.warn("[scratchpads] create failed:", created.failed[0]);
      return null;
    }
    return fresh;
  }

  const stats = await platformAdapter.fs.getMetadata(files);
  const modifiedByPath = new Map(
    stats.succeeded.map((m) => [m.path, m.modifiedAt]),
  );
  return pickMostRecentScratchpad(
    files.map((path) => ({ path, modifiedAt: modifiedByPath.get(path) })),
  );
}

/**
 * Entry-time cleanup, on plain disk truth: whitespace-only UNTITLED
 * scratchpads not in `keepPaths` (the tabs the entry is about to restore)
 * are deleted. Only auto-generated names qualify — a renamed scratchpad
 * expresses user intent even while still empty, and sweeping it would
 * silently destroy it (and with it the empty-entry auto-open). Best-effort;
 * failures warn, never throw. Rows catch up via the watcher and the
 * metadata walk.
 */
export async function sweepScratchpadsOnDisk(
  workspacePath: string,
  keepPaths: readonly string[],
): Promise<void> {
  const dir = scratchpadsDirPath(workspacePath);
  const listing = await platformAdapter.fs.readDirectory(dir, {
    recursive: false,
    includeFiles: true,
    includeDirectories: false,
  });
  if (!listing.ok) return;
  const keep = new Set(keepPaths);
  const candidates = listing.value.filter(
    (path) => !keep.has(path) && isUntitledBasename(pathutil.basename(path)),
  );
  if (candidates.length === 0) return;

  const reads = await platformAdapter.fs.readFiles(candidates);
  const empties = reads.succeeded
    .filter(({ content }) => content.trim() === "")
    .map(({ path }) => path);
  if (empties.length === 0) return;
  await platformAdapter.fs.deleteFiles(empties);
}
