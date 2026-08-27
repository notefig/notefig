import { FileTree, type FileTreeSortEntry } from "@pierre/trees";
import { FILE_ICON_CONFIG } from "./file-type-icon";
import type { SortOrder } from "@/utils/fs";
import { path as pathutil } from "@/utils/path";
import { isProtectedTreePath } from "@/entities/scratchpads";

/**
 * Module-level cache of @pierre/trees models, one per workspace.
 *
 * The model outlives the FileTree component (sidebar view switches unmount
 * it), so expansion, focus, scroll and selection survive by construction —
 * the React wrapper just re-attaches the cached model to a fresh host on
 * remount.
 *
 * Two consequences shape this module:
 * - Trees captures its option callbacks at construction. A cached model
 *   must never hold a component instance's closures, so every callback
 *   routes through `entry.delegate`, which the component reassigns on
 *   every render.
 * - The sync signature (`pathsSignature`) lives here too: the fs watcher
 *   keeps updating collections while the tree is unmounted, and the next
 *   mount compares against the last state the MODEL saw — an unchanged
 *   remount never resets, so scroll survives.
 */
export interface TreeDelegate {
  /** True for a DIRECTORY with open tabs somewhere inside — moving it would
   * orphan them. An open file itself is fine: the delegate's moveFile
   * routes it through the close-and-reopen rename. */
  containsOpenTab(absPath: string): boolean;
  moveFile(fromAbs: string, toAbs: string): void;
  renameFile(oldAbs: string, newName: string): void;
  createEntry(
    parentAbs: string,
    name: string,
    type: "file" | "directory",
  ): void;
}

export interface TreeSortState {
  order: SortOrder;
  /** canonical relative path → mtime millis; contents swapped in place. */
  modifiedByRelPath: Map<string, number>;
}

export interface TreeModelEntry {
  model: FileTree;
  sortState: TreeSortState;
  delegate: TreeDelegate;
  pendingCreate: { path: string; itemType: "file" | "directory" } | null;
  /** Sorted-joined treePaths the model last saw (resetPaths applied). */
  pathsSignature: string | null;
  /**
   * First-ever mount for this workspace: expand root-level directories once
   * the initial paths arrive. Baking initialExpansion into the model would
   * re-assert it on every resetPaths (sort switches).
   */
  needsDefaultExpansion: boolean;
}

const entriesByWorkspace = new Map<string, TreeModelEntry>();
const MAX_CACHED_WORKSPACES = 4;

/**
 * Parity with the pre-trees tree: files and directories sort together, names
 * compare lowercased, date-modified is newest-first by the entry's own mtime.
 * Trees compares entries across parent groups, so the comparator walks to the
 * first differing segment and compares the two SIBLINGS at that level.
 */
function makeComparator(sortState: TreeSortState) {
  const byName = (aName: string, bName: string) =>
    aName.toLowerCase().localeCompare(bName.toLowerCase());
  const compareSiblings = (
    aName: string,
    bName: string,
    aPath: string,
    bPath: string,
  ): number => {
    if (sortState.order === "name-desc") return byName(bName, aName);
    if (sortState.order === "date-modified") {
      const map = sortState.modifiedByRelPath;
      const modifiedA = map.get(aPath) ?? 0;
      const modifiedB = map.get(bPath) ?? 0;
      if (modifiedA !== modifiedB) return modifiedB - modifiedA;
    }
    return byName(aName, bName);
  };
  return (a: FileTreeSortEntry, b: FileTreeSortEntry) => {
    const aSegments = a.segments;
    const bSegments = b.segments;
    const shared = Math.min(aSegments.length, bSegments.length);
    for (let i = 0; i < shared; i++) {
      if (aSegments[i] !== bSegments[i]) {
        return compareSiblings(
          aSegments[i],
          bSegments[i],
          aSegments.slice(0, i + 1).join("/"),
          bSegments.slice(0, i + 1).join("/"),
        );
      }
    }
    // One path is the other's ancestor: ancestor first.
    return aSegments.length - bSegments.length;
  };
}

export function acquireTreeModel(
  workspacePath: string,
  init: {
    order: SortOrder;
    itemHeightPx: number;
    initialSelectedPaths: readonly string[];
    initialExpandedPaths: readonly string[] | null;
    delegate: TreeDelegate;
  },
): TreeModelEntry {
  const existing = entriesByWorkspace.get(workspacePath);
  if (existing) {
    // LRU touch
    entriesByWorkspace.delete(workspacePath);
    entriesByWorkspace.set(workspacePath, existing);
    existing.delegate = init.delegate;
    return existing;
  }

  const sortState: TreeSortState = {
    order: init.order,
    modifiedByRelPath: new Map(),
  };

  const entry: TreeModelEntry = {
    model: null as unknown as FileTree, // assigned below
    sortState,
    delegate: init.delegate,
    pendingCreate: null,
    pathsSignature: null,
    needsDefaultExpansion: init.initialExpandedPaths === null,
  };

  // Model paths are tree-domain ("/"-separated); only this seam converts
  // back to native absolute paths.
  const toAbs = (rel: string) =>
    pathutil.join(workspacePath, pathutil.fromTreePath(rel.replace(/\/+$/, "")));

  entry.model = new FileTree({
    paths: [],
    initialExpansion: "closed",
    initialExpandedPaths: init.initialExpandedPaths ?? undefined,
    initialSelectedPaths: init.initialSelectedPaths,
    sort: makeComparator(sortState),
    itemHeight: init.itemHeightPx,
    // The same monochrome icon set the prompt composer's mention picker and
    // the palette's quick results render (file-type-icon.tsx) — one config,
    // every surface agrees.
    icons: FILE_ICON_CONFIG,
    // The library hard-codes width/height ATTRIBUTES of 16 on the icon svg
    // (Icon.tsx), so the --trees-icon-width variable only sizes the lane —
    // rescaling the glyph itself to the 1.5x rem baseline needs CSS, which
    // beats presentation attributes. Flat rule only (nested CSS in this
    // shadow root segfaulted WebKit — bug 290102). File icons only; the
    // chevron keeps the library's own sizing + nudge.
    unsafeCSS: `
      [data-item-section="icon"] svg[data-icon-name="file-tree-icon-file"] {
        width: 0.9375rem;
        height: 0.9375rem;
        transform: translateY(0.0625rem);
      }
      [data-item-section="icon"] svg[data-icon-token="markdown"] {
        color: var(--logo);
      }
      [data-item-path=".metrists"], [data-item-path=".metrists/"] {
        opacity: 0.65;
        font-style: italic;
      }
      /* The scratchpads row displays as plain "scratchpads" — the tree
         flattens the .metrists/scratchpads chain into one row (its
         data-item-path is the deep one, trailing slash included) and the
         ".metrists / " prefix is just noise. Display-only: model paths,
         aria labels and search keep the real name, and no rename input
         can render here (the row is protected). */
      [data-item-path=".metrists/scratchpads/"] [data-item-section="content"] > * {
        display: none;
      }
      [data-item-path=".metrists/scratchpads/"] [data-item-section="content"]::after {
        content: "scratchpads";
      }
    `,
    dragAndDrop: {
      // Open-in-tab files CAN be moved — the delegate routes them through
      // the close-and-reopen rename so the tab follows the file. Blocked:
      // protected app paths, and directories with open tabs inside.
      canDrop: (context) =>
        !context.draggedPaths.some((p) => {
          if (isProtectedTreePath(p.replace(/\/+$/, ""))) return true;
          return entry.delegate.containsOpenTab(toAbs(p));
        }),
      onDropComplete: (event) => {
        // directoryPath arrives with a trailing slash ("docs/"); without
        // stripping it the destination becomes "docs//name", which round
        // trips through the optimistic collection update as a phantom
        // empty-named directory in the tree.
        const destDir = event.target.directoryPath?.replace(/\/+$/, "") ?? null;
        for (const dragged of event.draggedPaths) {
          const name = dragged.split("/").filter(Boolean).pop() ?? dragged;
          const destRel = destDir ? `${destDir}/${name}` : name;
          entry.delegate.moveFile(toAbs(dragged), toAbs(destRel));
        }
      },
      onDropError: (error) => console.error("Drop failed:", error),
    },
    renaming: {
      // Open files rename like closed ones (the delegate routes them
      // through the close-and-reopen rename); blocked: protected app
      // paths, and directories with open tabs inside.
      canRename: (item) =>
        !isProtectedTreePath(item.path.replace(/\/+$/, "")) &&
        !entry.delegate.containsOpenTab(toAbs(item.path)),
      onRename: (event) => {
        const pending = entry.pendingCreate;
        const newName =
          event.destinationPath.split("/").filter(Boolean).pop() ?? "";
        if (pending && pending.path === event.sourcePath) {
          entry.pendingCreate = null;
          const parentRel = event.destinationPath
            .split("/")
            .slice(0, -1)
            .join("/");
          const parentAbs = parentRel ? toAbs(parentRel) : workspacePath;
          // The placeholder row simply becomes the real row: the entry is
          // created on disk and the next data tick resyncs the model with
          // it present. (No model mutations here — mutating inside onRename
          // throws.)
          entry.delegate.createEntry(parentAbs, newName, pending.itemType);
        } else {
          entry.delegate.renameFile(toAbs(event.sourcePath), newName);
        }
      },
      onError: (error) => console.error("Rename failed:", error),
    },
  });

  // A cancelled create removes the placeholder from the model; clear the
  // pending marker so the next watcher diff doesn't resurrect confusion.
  entry.model.onMutation("remove", (event) => {
    if (entry.pendingCreate?.path === event.path) {
      entry.pendingCreate = null;
    }
  });

  entriesByWorkspace.set(workspacePath, entry);

  // Evict least-recently-used models beyond the cap.
  while (entriesByWorkspace.size > MAX_CACHED_WORKSPACES) {
    const [oldestKey, oldest] = entriesByWorkspace.entries().next().value as [
      string,
      TreeModelEntry,
    ];
    entriesByWorkspace.delete(oldestKey);
    oldest.model.cleanUp();
  }

  return entry;
}
