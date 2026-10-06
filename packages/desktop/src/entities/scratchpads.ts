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
 * generated-name file here, and opening a project lands in the most recent
 * one (`enter`, run by scratchpad-landing.ts), after an entry-time
 * sweep deletes abandoned empty ones — any name: the folder is app
 * territory, and an empty file holds nothing worth keeping, however it got
 * its name. The "scratchpad on startup" app setting turns the landing half
 * off entirely — no create, no auto-open; only the sweep still runs. In every other respect
 * — renaming, dragging, tab titles, deletion — they are ordinary files
 * with no special treatment. Entry lifecycle runs on plain adapter fs —
 * never on collections — so it cannot race collection or query readiness;
 * rows catch up via the normal metadata walk.
 */
import { defineModule } from "@notefig/core";
import type { FileSystemSurface } from "@/adapters/platform-adapter.interface";
import { SETTINGS_NAMESPACE } from "@/hooks/use-app-settings";
import { path as pathutil } from "@/utils/path";
import { stripPromptMarkers } from "@notefig/widgets";
import {
  APP_DIR_NAME,
  SCRATCHPADS_DIR_NAME,
  SCRATCHPADS_REL_PATH,
} from "@/utils/app-dir";
import type { WorkspaceFiles } from "./files";

// ---------------------------------------------------------------------------
// Path scheme & naming (pure)
// ---------------------------------------------------------------------------

// The names live in the leaf utils/app-dir so utils/history-service can
// reach them without importing this entity (and closing a cycle through
// ./files); re-exported here because this module is the access path.
export { APP_DIR_NAME, SCRATCHPADS_DIR_NAME, SCRATCHPADS_REL_PATH };

// Docker/Heroku-style generated names ("sunny-otter.md"): random, cute,
// and assigned at creation — no rename step, no "untitled-4.md" pile.
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
// One workspace's scratchpads — `core.workspace(ws).scratchpads`
// ---------------------------------------------------------------------------

/** What a workspace's scratchpads are built from. */
export interface ScratchpadsDeps {
  workspacePath: string;
  /** The workspace's files: where a new scratchpad is created, and the
   *  listing that re-walks after the entry's disk work. */
  files: Pick<WorkspaceFiles, "file" | "collections" | "refetchMetadata">;
  /** Entry works on plain disk truth, never on collections, so it cannot
   *  race collection or query readiness. */
  fs: Pick<
    FileSystemSurface,
    | "readDirectory"
    | "createFiles"
    | "getMetadata"
    | "readFiles"
    | "deleteFiles"
  >;
  /** The "scratchpad on startup" setting: off means entry lands nowhere. */
  landsOnStartup(): Promise<boolean>;
  /** Open a fresh scratchpad as the user's own gesture's tab. */
  openTab(path: string): void;
}

export interface WorkspaceScratchpads {
  /** "New File": a fresh generated-name scratchpad; resolves to its path.
   *  Never targets an existing path — the create path truncates. */
  create(): Promise<string>;
  /**
   * The "New File" action: create one and open it as a tab. Shared by the
   * Mod+N command, the palette, the sidebar and the status menu.
   */
  createAndOpen(): void;
  /**
   * What entering the workspace lands on: sweep abandoned empty
   * scratchpads (never one in `keepPaths` — the tabs already open), then
   * the most recent survivor or a fresh one — or nothing with "scratchpad
   * on startup" off. Never rejects: a failure degrades to nothing. The
   * sweep and create mutate disk behind the collections' back, so this
   * resolves only once a re-walk that saw them has landed — the caller then
   * adds the tab to a layout whose row already exists, and the stale-tab
   * pruner never sees it rowless.
   */
  enter(keepPaths: readonly string[]): Promise<string | null>;
  /**
   * The entry sweep alone, for an entry with nothing to land on (one of the
   * workspace's files is already open): abandoned empty scratchpads go,
   * the open tabs are kept, and the listing re-walks so the tree and any
   * tab on a swept file catch up. Never rejects.
   */
  sweep(keepPaths: readonly string[]): Promise<void>;
}

export function createWorkspaceScratchpads({
  workspacePath,
  files,
  fs,
  landsOnStartup,
  openTab,
}: ScratchpadsDeps): WorkspaceScratchpads {
  const dir = scratchpadsDirPath(workspacePath);

  const scratchpadRows = () =>
    files.collections.metadata.toArray.filter((row) =>
      isScratchpadFileRow(row),
    );

  /** A file squatting on a path we need as a directory disables the
   *  feature. */
  const dirIsBlocked = () =>
    [dir, pathutil.dirname(dir)].some(
      (candidate) => files.collections.metadata.get(candidate)?.type === "file",
    );

  const create = async () => {
    if (dirIsBlocked()) {
      throw new Error("a file occupies the scratchpads directory path");
    }
    const basenames = scratchpadRows().map((row) =>
      pathutil.basename(row.path),
    );
    const filePath = pathutil.join(dir, randomScratchpadBasename(basenames));
    await files.file(filePath).create();
    return filePath;
  };

  const listOnDisk = () =>
    fs.readDirectory(dir, {
      recursive: false,
      includeFiles: true,
      includeDirectories: false,
    });

  /** The most recently modified scratchpad on disk, else a freshly created
   *  one. Null bails to nothing (a file squatting on the folder path). */
  const resolveOnDisk = async (): Promise<string | null> => {
    const listing = await listOnDisk();
    if (!listing.ok && listing.error.type !== "not_found") {
      console.warn("[scratchpads] cannot use the folder:", listing.error);
      return null;
    }
    const paths = listing.ok ? listing.value.map((entry) => entry.path) : [];

    if (paths.length === 0) {
      const fresh = pathutil.join(dir, randomScratchpadBasename([]));
      const created = await fs.createFiles([fresh]);
      if (created.failed.length > 0) {
        console.warn("[scratchpads] create failed:", created.failed[0]);
        return null;
      }
      return fresh;
    }

    const stats = await fs.getMetadata(paths);
    const modifiedByPath = new Map(
      stats.succeeded.map((m) => [m.path, m.modifiedAt]),
    );
    return pickMostRecentScratchpad(
      paths.map((path) => ({ path, modifiedAt: modifiedByPath.get(path) })),
    );
  };

  /**
   * Whitespace-only scratchpads not in `keepPaths` are deleted — whatever
   * their name. The folder is app territory; an empty file holds no user
   * work whether its name was generated or chosen, and a name-based
   * carve-out would make the sweep depend on whether a name looks like
   * one of ours. Rows catch up via the watcher and the metadata walk.
   */
  const sweepOnDisk = async (keepPaths: readonly string[]) => {
    const listing = await listOnDisk();
    if (!listing.ok) return;
    const keep = new Set(keepPaths);
    const candidates = listing.value
      .map((entry) => entry.path)
      .filter((path) => !keep.has(path));
    if (candidates.length === 0) return;

    const reads = await fs.readFiles(candidates);
    const empties = reads.succeeded
      // A persisted prompt widget (MET-163) is the only thing an abandoned
      // scratchpad may hold and still count as empty: the user typed a
      // prompt that produced nothing, so the file is as disposable as a
      // blank one.
      .filter(({ content }) => stripPromptMarkers(content).trim() === "")
      .map(({ path }) => path);
    if (empties.length === 0) return;
    await fs.deleteFiles(empties);
  };

  return {
    create,
    createAndOpen() {
      void create()
        // The user asked for something to type into: the new document's
        // own claim (its prompt widget) may take focus from whatever field
        // they were in — a hand-off the gesture grants, not the widget.
        .then(openTab)
        .catch((error) => console.error("Failed to create a new file:", error));
    },
    async enter(keepPaths) {
      let scratchpad: string | null = null;
      try {
        await sweepOnDisk(keepPaths);
        if (await landsOnStartup()) scratchpad = await resolveOnDisk();
      } catch (error) {
        console.error("[scratchpads] entry resolution failed:", error);
      }
      await files.refetchMetadata();
      return scratchpad;
    },
    async sweep(keepPaths) {
      try {
        await sweepOnDisk(keepPaths);
      } catch (error) {
        console.error("[scratchpads] entry sweep failed:", error);
      }
      await files.refetchMetadata();
    },
  };
}

declare module "@notefig/core" {
  interface WorkspaceModules {
    scratchpads: WorkspaceScratchpads;
  }
}

export const scratchpadsModule = defineModule({
  name: "scratchpads",
  needs: ["platform", "tabs", "kv"],
  workspace: {
    needs: ["files"],
    create: (ctx) => {
      const tabs = ctx.use("tabs");
      const kv = ctx.use("kv");
      return createWorkspaceScratchpads({
        workspacePath: pathutil.normalize(ctx.workspace.path),
        files: ctx.useWorkspace("files"),
        fs: ctx.use("platform").fs,
        landsOnStartup: async () =>
          (await kv.read<boolean>(
            SETTINGS_NAMESPACE,
            "scratchpadOnStartup",
          )) !== false,
        // Only once the tab is really in the dock does the gesture's
        // hand-off apply (an open the editor refuses leaves nothing to
        // own the grant).
        openTab: (path) =>
          void tabs.open(path, { intent: "replace", handoff: true }),
      });
    },
  },
});
