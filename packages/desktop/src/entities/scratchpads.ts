/**
 * Scratchpads entity (MET-135): where nameless new files live. "New File"
 * instantly creates a markdown file with a generated cute name
 * (Docker/Heroku-style "sunny-otter.md") in the app-owned
 * `.notefig/scratchpads/` folder; membership in that folder — not the
 * filename — is what makes a file a scratchpad. Scratchpads never reach the
 * user's git (the `.notefig/` exclude covers them) but ARE checkpointed by
 * the app's history repo, whose own exclude history-service narrows to this
 * one folder. Moving a file out of the folder is how it becomes a tracked
 * project file. Scratchpads are also the ONLY child of the app dir the fs
 * walkers and the watcher surface — everything else under `.notefig/` is
 * hidden by position, so app-internal files need no dot prefix. Consumers
 * derive every path from the constants here.
 *
 * This file is the whole feature, and the feature is deliberately small.
 * Scratchpads have exactly two special powers: "New File" auto-creates a
 * generated-name file here, and an empty workspace entry auto-opens the
 * most recent one (useNavigationPersistence folds it into the entry URL),
 * after an entry-time sweep deletes abandoned empty generated-name ones
 * (renamed files are the user's, even while empty). The "scratchpad on
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
import { stripPromptMarkers } from "@notefig/widgets";
import {
  APP_DIR_NAME,
  SCRATCHPADS_DIR_NAME,
  SCRATCHPADS_REL_PATH,
} from "@/utils/app-dir";
import {
  createFile,
  getOrCreateWorkspaceCollections,
  type FileMetadata,
} from "./files";

// ---------------------------------------------------------------------------
// Path scheme & naming (pure)
// ---------------------------------------------------------------------------

// The names live in the leaf utils/app-dir so utils/history-service can
// reach them without importing this entity (and closing a cycle through
// ./files); re-exported here because this module is the access path.
export { APP_DIR_NAME, SCRATCHPADS_DIR_NAME, SCRATCHPADS_REL_PATH };

// Docker/Heroku-style generated names ("sunny-otter.md"): random, cute,
// and assigned at creation — no rename step, no "untitled-4.md" pile.
// The lists double as the recognizer for our own output (the sweep may
// only delete names WE generated), so words must never contain "-".
const NAME_ADJECTIVES = [
  "amber",
  "breezy",
  "bright",
  "bubbly",
  "brave",
  "cheery",
  "chipper",
  "coral",
  "cozy",
  "dandy",
  "dapper",
  "dreamy",
  "fuzzy",
  "gentle",
  "glossy",
  "golden",
  "groovy",
  "humble",
  "indigo",
  "jolly",
  "lilac",
  "lively",
  "lucky",
  "mellow",
  "merry",
  "minty",
  "nimble",
  "olive",
  "peppy",
  "perky",
  "plucky",
  "quirky",
  "rosy",
  "silky",
  "snug",
  "sprightly",
  "sunny",
  "tidy",
  "velvet",
  "witty",
  "zesty",
];
const NAME_NOUNS = [
  "acorn",
  "badger",
  "beaver",
  "brook",
  "bunny",
  "chipmunk",
  "clover",
  "dolphin",
  "falcon",
  "fox",
  "gecko",
  "hedgehog",
  "heron",
  "kitten",
  "koala",
  "lemur",
  "magpie",
  "maple",
  "marmot",
  "meadow",
  "newt",
  "ocelot",
  "otter",
  "owl",
  "panda",
  "pebble",
  "penguin",
  "puffin",
  "quokka",
  "raccoon",
  "robin",
  "seal",
  "sparrow",
  "squirrel",
  "tanuki",
  "toucan",
  "walrus",
  "willow",
  "wombat",
  "yak",
];

/** A basename this module generates now ("sunny-otter.md", counter-suffixed
 * on collision) or ever generated (the legacy "untitled-x.md" scheme, still
 * on disk in real workspaces). Anything else carries a user-chosen name. */
export function isGeneratedScratchpadBasename(basename: string): boolean {
  const match = /^([a-z]+)-([a-z]+)(?:-\d+)?\.md$/.exec(basename);
  if (match) {
    return NAME_ADJECTIVES.includes(match[1]) && NAME_NOUNS.includes(match[2]);
  }
  return /^untitled(?:-\d+)?\.md$/.test(basename);
}

/** A fresh random name avoiding `existingBasenames` (case-insensitive —
 * mac and Windows filesystems are); after a bounded retry the last pick
 * gets a counter suffix so the function always returns. */
export function randomScratchpadBasename(existingBasenames: string[]): string {
  const taken = new Set(existingBasenames.map((b) => b.toLowerCase()));
  const pick = (list: string[]) =>
    list[Math.floor(Math.random() * list.length)];
  let name = "";
  for (let attempt = 0; attempt < 20; attempt++) {
    name = `${pick(NAME_ADJECTIVES)}-${pick(NAME_NOUNS)}`;
    if (!taken.has(`${name}.md`)) return `${name}.md`;
  }
  let counter = 2;
  while (taken.has(`${name}-${counter}.md`)) counter += 1;
  return `${name}-${counter}.md`;
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

/** "New File": create a fresh generated-name scratchpad, return its path.
 * Never targets an existing path — the create path truncates. */
export async function createGeneratedScratchpad(
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
    randomScratchpadBasename(basenames),
  );
  await createFile(workspacePath, filePath);
  return filePath;
}

/** The "New File" action: create a fresh generated-name scratchpad and open
 * it as a tab. Shared by the Mod+N command, the palette, and the sidebar. */
export function createAndOpenScratchpad(
  workspacePath: string,
  openFile: (options: OpenFileInLayoutOptions) => boolean,
): void {
  void createGeneratedScratchpad(workspacePath)
    .then((path) => openFile({ tabId: path, intent: "replace" }))
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
  const files = listing.ok ? listing.value.map((entry) => entry.path) : [];

  if (files.length === 0) {
    const fresh = pathutil.join(dir, randomScratchpadBasename([]));
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
 * Entry-time cleanup, on plain disk truth: whitespace-only GENERATED-NAME
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
  const candidates = listing.value
    .map((entry) => entry.path)
    .filter(
      (path) =>
        !keep.has(path) &&
        isGeneratedScratchpadBasename(pathutil.basename(path)),
    );
  if (candidates.length === 0) return;

  const reads = await platformAdapter.fs.readFiles(candidates);
  const empties = reads.succeeded
    // A persisted prompt widget (MET-163) is the only thing an abandoned
    // scratchpad may hold and still count as empty: the user typed a prompt
    // that produced nothing, so the file is as disposable as a blank one.
    .filter(({ content }) => stripPromptMarkers(content).trim() === "")
    .map(({ path }) => path);
  if (empties.length === 0) return;
  await platformAdapter.fs.deleteFiles(empties);
}
