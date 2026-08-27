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
 * This file is the whole feature: path scheme + naming, the user-facing
 * "New File" action, and the disk-based entry lifecycle (sweep +
 * resolve) that useNavigationPersistence folds into the workspace entry
 * URL. Lifecycle runs on plain adapter fs — never on collections — so it
 * cannot race collection or query readiness; rows catch up via the
 * normal metadata walk. Nothing happens on tab close; leftovers are
 * cleaned and renamed at the next workspace entry.
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

/** Temporary MET-135 diagnostics — grep for [scratchpad-debug]. */
export function scratchpadDebug(...parts: unknown[]): void {
  console.info("[scratchpad-debug]", ...parts);
}

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
  scratchpadDebug("resolve(disk): candidates", files);

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
 * Entry-time sweep, on plain disk truth, over scratchpads not in
 * `keepPaths` (the tabs the entry is about to restore): whitespace-only
 * leftovers are deleted, untitled ones with content are renamed to their
 * heading (`<slug>-<random>.md`). Best-effort; failures warn, never
 * throw. Rows catch up via the watcher and the metadata walk.
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
  const taken = new Set(listing.value.map((p) => pathutil.basename(p)));
  const candidates = listing.value.filter((path) => !keep.has(path));
  scratchpadDebug("sweep(disk): candidates", candidates, "keep", keepPaths);
  if (candidates.length === 0) return;

  const reads = await platformAdapter.fs.readFiles(candidates);
  for (const { path, content } of reads.succeeded) {
    if (content.trim() === "") {
      scratchpadDebug("sweep(disk): deleting empty", path);
      await platformAdapter.fs.deleteFiles([path]);
      taken.delete(pathutil.basename(path));
    } else if (isUntitledBasename(pathutil.basename(path))) {
      await renameScratchpadToHeading(dir, path, content, taken);
    }
  }
}

/** Rename one untitled scratchpad to its heading slug, de-duped against
 * `taken` (updated in place). No-op when no heading survives slugging. */
async function renameScratchpadToHeading(
  dir: string,
  path: string,
  content: string,
  taken: Set<string>,
): Promise<void> {
  const title = deriveScratchpadTitle(content);
  const slug = title ? slugifyScratchpadTitle(title) : null;
  if (!slug) return;
  let name = `${slug}-${randomScratchpadSuffix()}.md`;
  for (let i = 0; i < 3 && taken.has(name); i++) {
    name = `${slug}-${randomScratchpadSuffix()}.md`;
  }
  const target = pathutil.join(dir, name);
  scratchpadDebug("sweep(disk): renaming", path, "->", target);
  const moved = await platformAdapter.fs.moveFile(path, target);
  if (moved.ok) {
    taken.delete(pathutil.basename(path));
    taken.add(name);
  } else {
    console.warn("[scratchpads] rename failed:", moved.error);
  }
}
