import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  FileTree as TreesFileTree,
  type FileTreeProps as TreesFileTreeProps,
} from "@pierre/trees/react";
import type { ContextMenuItem, ContextMenuOpenContext } from "@pierre/trees";
import {
  ExternalLink,
  FilePlus,
  FolderPlus,
  PenLine,
  Trash2,
} from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import {
  getDirectoryPath,
  getFileName,
  type SortOrder,
  type FileTreeNode,
} from "@/utils/fs";
import {
  useFileCollections,
  renameFileOrDirectory,
  prefetchFileContent,
} from "@/entities/files";
import { useLiveQuery } from "@tanstack/react-db";
import type { OpenFileInLayoutOptions } from "@/utils/dockable-layout";
import { dropZoneProps, tagCurrentDrag } from "@/utils/drag-protocol";
import { path as pathutil, relativeTreePath } from "@/utils/path";
import { isProtectedTreePath, isScratchpadPath } from "@/entities/scratchpads";
import { moveIntoFolder } from "@/utils/drop-actions";
import { attachTreeStatHydration } from "./tree-stat-hydration";
import {
  attachExpansionMemory,
  rememberedExpandedPaths,
} from "./tree-expansion-memory";
import { acquireTreeModel } from "./tree-model-cache";

/** Discriminated union representing the file tree's inline-editing state. */
export type FileTreeMode =
  | { type: "idle" }
  | { type: "renaming"; path: string }
  | { type: "creating"; parentPath: string; itemType: "file" | "directory" };

export const FILE_TREE_IDLE: FileTreeMode = { type: "idle" };

/**
 * The sidebar file tree, rendered by @pierre/trees (virtualized, keyboard
 * navigable, ARIA tree in a shadow root).
 *
 * The model itself lives in tree-model-cache.ts, one per workspace, and
 * OUTLIVES this component: sidebar view switches and sort changes reattach
 * the cached model instead of rebuilding it, so expansion/scroll/focus
 * survive. All trees option callbacks route through the cache entry's
 * mutable delegate — this component reassigns it every render, so the
 * long-lived model never holds stale component closures.
 *
 * Integration decisions vs. the library defaults:
 * - No in-tree search yet (fast follow) — also keeps DOM focus on rows
 *   instead of the search input's fake-focus scheme.
 * - No git status, no file-type icons.
 * - Mod+click opens in a new tab (our convention); trees' built-in
 *   mod/shift multi-select is intercepted before it reaches the model.
 * - Theming lives in styles.css (`file-tree-container` block) via the
 *   --trees-theme-* slots + color-scheme; row height is computed from the
 *   root font-size so the 1.5x UI-scale baseline holds.
 * - Drag interop: internal moves are trees' native drag; host dragstart
 *   tags the protocol payload so dockable tab bars accept tree rows, and a
 *   host-level protocol dropzone routes image-asset drops (dnd-kit pointer
 *   drags can't see shadow-DOM rows) to the hovered folder by hit-testing
 *   into the shadow root.
 */
interface FileTreeComponentProps {
  selectedFilePath: string | null;
  onFileSelect: (
    file: FileTreeNode,
    options?: Omit<OpenFileInLayoutOptions, "tabId">,
  ) => void;
  onDelete?: (path: string) => void;
  onRename?: (oldPath: string, newName: string) => void;
  /** Rename/move a file whose tab is open (close-and-reopen primitive). */
  onRenameOpenFile?: (oldPath: string, newPath: string) => Promise<void>;
  onCreate?: (
    parentPath: string,
    name: string,
    type: "file" | "directory",
  ) => void;
  openTabs?: string[];
  basePath: string;
  sortOrder?: SortOrder;
  mode: FileTreeMode;
  onModeChange: (mode: FileTreeMode) => void;
}

/** Row height in rem: text-sm line-height (1.25rem) + py-1 top/bottom. */
const ROW_HEIGHT_REM = 1.75;

export function FileTree(props: FileTreeComponentProps) {
  // Remount per workspace: the inner component's transient state (pending
  // delete dialog, hover memo) must not leak across workspaces. The MODEL
  // is cached per workspace either way.
  return <FileTreeInner key={props.basePath} {...props} />;
}

// fallow-ignore-next-line complexity
function FileTreeInner({
  selectedFilePath,
  onFileSelect,
  onDelete,
  onRename,
  onRenameOpenFile,
  onCreate,
  openTabs,
  basePath,
  sortOrder = "name-asc",
  mode,
  onModeChange,
}: FileTreeComponentProps) {
  const { t } = useTranslation();
  const { metadata } = useFileCollections(basePath);

  const toAbs = useCallback(
    (rel: string) =>
      pathutil.join(basePath, pathutil.fromTreePath(rel.replace(/\/+$/, ""))),
    [basePath],
  );
  const toRel = useCallback(
    (abs: string) => relativeTreePath(basePath, abs) || abs,
    [basePath],
  );

  const { data: fileMetadataList = [] } = useLiveQuery(
    (q) =>
      q.from({ file: metadata }).select(({ file }) => ({
        path: file.path,
        relativePath: file.relativePath,
        type: file.type,
        modified: file.modified,
      })),
    [basePath],
  );

  // Trees marks directories with a trailing slash in the input path list.
  // Collapse duplicate slashes defensively: a malformed segment would make
  // trees materialize an empty-named phantom directory.
  const treePaths = useMemo(() => {
    return fileMetadataList
      .filter((entry) => entry.relativePath)
      .map((entry) => {
        const rel = entry.relativePath!.replace(/\/{2,}/g, "/");
        return entry.type === "directory" ? `${rel}/` : rel;
      });
  }, [fileMetadataList]);

  const selectedFilePathRef = useRef(selectedFilePath);
  selectedFilePathRef.current = selectedFilePath;

  const openTabsRef = useRef(openTabs);
  openTabsRef.current = openTabs;
  const isPathOpenInTab = useCallback((absPath: string) => {
    const tabs = openTabsRef.current ?? [];
    return tabs.some((tab) => pathutil.contains(absPath, tab));
  }, []);

  const [pendingDelete, setPendingDelete] = useState<{
    path: string;
    type: "file" | "directory";
  } | null>(null);

  // Row height must agree between the model (virtualization math) and the
  // shadow CSS; both derive from the root font-size so UI scale is honored.
  const [itemHeightPx] = useState(() =>
    Math.round(
      parseFloat(getComputedStyle(document.documentElement).fontSize) *
        ROW_HEIGHT_REM,
    ),
  );

  const entry = useMemo(
    () =>
      acquireTreeModel(basePath, {
        order: sortOrder,
        itemHeightPx,
        initialSelectedPaths: selectedFilePathRef.current
          ? [
              relativeTreePath(basePath, selectedFilePathRef.current) ||
                selectedFilePathRef.current,
            ]
          : [],
        initialExpandedPaths: rememberedExpandedPaths(basePath),
        delegate: {
          isPathOpenInTab: () => false,
          isPromotableScratchpad: () => false,
          moveFile: () => {},
          renameFile: () => {},
          createEntry: () => {},
        },
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- acquisition
    // inputs are first-creation-only; the delegate below tracks renders.
    [basePath, itemHeightPx],
  );
  const model = entry.model;

  // The long-lived model calls into the app through this delegate — refresh
  // it every render so it never sees stale props.
  entry.delegate = {
    isPathOpenInTab,
    isPromotableScratchpad: (abs) => isScratchpadPath(basePath, abs),
    moveFile: (fromAbs, destAbs) => {
      // Dragging an OPEN scratchpad out of its folder is promotion — route
      // through the close-and-reopen rename so the tab follows the file.
      const move =
        isScratchpadPath(basePath, fromAbs) &&
        (openTabsRef.current ?? []).includes(fromAbs) &&
        onRenameOpenFile
          ? onRenameOpenFile(fromAbs, destAbs)
          : renameFileOrDirectory(basePath, fromAbs, destAbs);
      move.catch((error: unknown) => {
        console.error(`Failed to move ${fromAbs}:`, error);
      });
    },
    renameFile: (oldAbs, newName) => onRename?.(oldAbs, newName),
    createEntry: (parentAbs, name, type) => onCreate?.(parentAbs, name, type),
  };

  // Mutable lookup for the date-modified comparator (the cache's comparator
  // reads sortState at compare time). Filled synchronously: sorts can run
  // during this same render pass.
  entry.sortState.modifiedByRelPath = useMemo(() => {
    const next = new Map<string, number>();
    for (const item of fileMetadataList) {
      if (item.relativePath) {
        next.set(
          item.relativePath.replace(/\/{2,}/g, "/"),
          item.modified ? new Date(item.modified).getTime() : 0,
        );
      }
    }
    return next;
  }, [fileMetadataList]);

  const treePathsRef = useRef(treePaths);
  treePathsRef.current = treePaths;

  // Lazy metadata hydration (MET-99) — see tree-stat-hydration.ts.
  useEffect(
    () => attachTreeStatHydration(model, basePath, toAbs),
    [model, basePath, toAbs],
  );

  // Mirror expansion into the module store — see tree-expansion-memory.ts.
  // With the cached model, this feeds sort-switch resets and rebuilds after
  // cache eviction.
  useEffect(() => attachExpansionMemory(model, basePath), [model, basePath]);

  // Single-selection semantics: item.select() is additive in trees, so clear
  // the rest whenever we programmatically mirror the active tab.
  const selectOnly = useCallback(
    (rel: string) => {
      for (const selected of model.getSelectedPaths()) {
        if (selected !== rel) model.getItem(selected)?.deselect();
      }
      const item = model.getItem(rel);
      if (item && !item.isSelected()) item.select();
    },
    [model],
  );

  // Sort changes retune the cached model in place (trees only sorts on
  // insert/reset): flip the comparator's mode and reset with the remembered
  // expansion shape.
  useEffect(() => {
    if (entry.sortState.order === sortOrder) return;
    entry.sortState.order = sortOrder;
    model.resetPaths(treePathsRef.current, {
      initialExpandedPaths: rememberedExpandedPaths(basePath) ?? [],
    });
    if (selectedFilePathRef.current) {
      selectOnly(toRel(selectedFilePathRef.current));
    }
  }, [sortOrder, entry, model, basePath, selectOnly, toRel]);

  // Open files from explicit gestures (click / Enter on a row), NOT from
  // onSelectionChange: the model applies selection as a side effect of
  // startRenaming and programmatic sync, which must not open tabs.
  const openFileAtPath = useCallback(
    (rel: string, options?: Omit<OpenFileInLayoutOptions, "tabId">) => {
      const abs = toAbs(rel);
      if (!options?.intent && abs === selectedFilePathRef.current) return;
      onFileSelect(
        { path: abs, type: "file", contentHash: "", content: "" },
        options,
      );
    },
    [toAbs, onFileSelect],
  );

  const findRowInComposedPath = useCallback((event: Event) => {
    for (const target of event.composedPath()) {
      if (!(target instanceof HTMLElement)) continue;
      const path = target.dataset.itemPath;
      if (path && target.dataset.itemType) {
        return { path, type: target.dataset.itemType };
      }
    }
    return null;
  }, []);

  const handleHostClick = useCallback(
    (event: React.MouseEvent) => {
      const row = findRowInComposedPath(event.nativeEvent);
      if (row?.type === "file") openFileAtPath(row.path);
    },
    [findRowInComposedPath, openFileAtPath],
  );

  // Our convention: Mod+click opens in a new tab. Trees' own convention is
  // mod/shift multi-select — intercept in the capture phase so the modifier
  // click never reaches the model's selection logic.
  // fallow-ignore-next-line complexity
  const handleHostClickCapture = useCallback(
    (event: React.MouseEvent) => {
      if (!(event.metaKey || event.ctrlKey || event.shiftKey)) return;
      const row = findRowInComposedPath(event.nativeEvent);
      if (!row) return;
      event.preventDefault();
      event.stopPropagation();
      if (row.type === "file") {
        const newTab = event.metaKey || event.ctrlKey;
        openFileAtPath(row.path, newTab ? { intent: "new-tab" } : undefined);
      } else {
        const item = model.getItem(row.path);
        if (item && "toggle" in item) item.toggle();
      }
    },
    [findRowInComposedPath, openFileAtPath, model],
  );

  // Hover prefetch, same behavior as the previous tree's per-row mouseenter.
  const lastHoveredRef = useRef<string | null>(null);
  const handleHostMouseOver = useCallback(
    (event: React.MouseEvent) => {
      const row = findRowInComposedPath(event.nativeEvent);
      if (!row || row.type !== "file") return;
      if (lastHoveredRef.current === row.path) return;
      lastHoveredRef.current = row.path;
      prefetchFileContent(basePath, toAbs(row.path)).catch((error: unknown) => {
        console.debug(`Failed to prefetch ${row.path}:`, error);
      });
    },
    [findRowInComposedPath, basePath, toAbs],
  );

  // Trees' internal drags are native HTML5. Tag them with the protocol
  // payload so protocol dropzones outside the tree (dockable tab bars)
  // accept tree rows; internal tree moves are unaffected.
  const handleHostDragStart = useCallback(
    (event: React.DragEvent) => {
      if (event.defaultPrevented) return;
      const row = findRowInComposedPath(event.nativeEvent);
      if (!row || !event.dataTransfer) return;
      tagCurrentDrag(
        {
          kind: "file",
          path: toAbs(row.path),
          fileType: row.type === "folder" ? "directory" : "file",
          workspaceRoot: basePath,
        },
        event.dataTransfer,
      );
    },
    [findRowInComposedPath, toAbs, basePath],
  );

  // Focus-arbiter parity: the arbiter resolves data-focus-key via
  // document.querySelector, which cannot see into the shadow root. The host
  // carries the key; when the arbiter focuses it, delegate to the first row.
  // document.activeElement stays on the host while focus is inside its
  // shadow tree, so the arbiter's ownership check keeps holding.
  const pendingFirstFocusRef = useRef(false);
  const focusFirstRow = useCallback(() => {
    if (model.getVisibleCount() === 0) {
      // Rows haven't loaded yet (mount-time arbiter intent races the live
      // query); complete the hand-off when the first reconcile lands.
      pendingFirstFocusRef.current = true;
      return;
    }
    pendingFirstFocusRef.current = false;
    model.focusFirstItem();
    requestAnimationFrame(() => {
      const container = model.getFileTreeContainer();
      const rowButton = container?.shadowRoot?.querySelector<HTMLElement>(
        '[data-type="item"][tabindex="0"]',
      );
      rowButton?.focus({ preventScroll: true });
    });
  }, [model]);

  const handleHostFocus = useCallback(
    (event: React.FocusEvent) => {
      // Focus events from inside the shadow tree retarget to the host, so
      // target === currentTarget even when the user clicked a row. Only
      // delegate when the HOST ITSELF took focus (arbiter hand-off): then
      // nothing inside the shadow root holds focus.
      const host = event.currentTarget as HTMLElement;
      if (host.shadowRoot?.activeElement) return;
      // An in-flight inline rename owns focus next — delegating now would
      // blur its input, and blur commits the rename.
      if (host.shadowRoot?.querySelector("[data-item-rename-input]")) return;
      // Focus falling out of our own light-DOM children (the slotted
      // context menu unmounting) is internal churn, not an arbiter grant.
      if (
        event.relatedTarget instanceof Node &&
        host.contains(event.relatedTarget)
      ) {
        return;
      }
      focusFirstRow();
    },
    [focusFirstRow],
  );

  // Reset the model to the given paths, carrying expansion and selection
  // over. The expansion mirror knows about dirs hidden under collapsed
  // ancestors too, unlike a scan of the visible projection.
  const resetModelPaths = useCallback(
    (paths: string[], extraExpanded: readonly string[] = []) => {
      const expanded = new Set(
        rememberedExpandedPaths(basePath) ??
          model
            .getVisibleRows(0, model.getVisibleCount())
            .filter((row) => row.kind === "directory" && row.isExpanded)
            .map((row) => row.path.replace(/\/+$/, "")),
      );
      for (const path of extraExpanded) expanded.add(path);
      model.resetPaths(paths, { initialExpandedPaths: [...expanded] });
      if (selectedFilePathRef.current) {
        selectOnly(toRel(selectedFilePathRef.current));
      }
    },
    [model, basePath, selectOnly, toRel],
  );

  // Feed the model the way trees is designed to be fed: resetPaths with the
  // full list (the same call the sort effects use) — trees reconciles
  // internally, expansion and selection are re-applied by resetModelPaths.
  // The signature lives on the cache entry so a remount with unchanged data
  // never resets (scroll survives), while watcher writes that land during
  // unmount are picked up on the next mount. (MET-130: the previous
  // hand-rolled add/remove diff kept a knownPaths mirror that went
  // permanently stale whenever its batch threw — deleted files stayed on
  // screen.)
  useEffect(() => {
    const signature = treePaths.slice().sort().join("\n");
    if (signature !== entry.pathsSignature) {
      // Never yank an in-progress inline edit (rename/create): the commit
      // itself writes to the collection, so a fresh tick re-runs this.
      const container = model.getFileTreeContainer();
      if (container?.shadowRoot?.querySelector("[data-item-rename-input]")) {
        return;
      }
      entry.pathsSignature = signature;
      // On the workspace's very first tree the default shape is root-level
      // directories open — merged in explicitly, because the expansion
      // mirror attaches (empty) the moment the tree mounts and so can't be
      // the null-signal.
      const applyDefault = entry.needsDefaultExpansion;
      if (treePaths.length > 0) entry.needsDefaultExpansion = false;
      resetModelPaths(
        treePaths,
        applyDefault
          ? treePaths
              .filter((p) => p.endsWith("/") && !p.slice(0, -1).includes("/"))
              .map((p) => p.replace(/\/+$/, ""))
          : [],
      );
    }

    // Complete a deferred focus hand-off, but only if the host still holds
    // focus — never steal it back after the user has moved on.
    if (
      pendingFirstFocusRef.current &&
      model.getVisibleCount() > 0 &&
      document.activeElement === model.getFileTreeContainer()
    ) {
      focusFirstRow();
    }
  }, [treePaths, entry, model, focusFirstRow, resetModelPaths]);

  // Keep tree selection in sync with the active tab.
  useEffect(() => {
    if (!selectedFilePath) return;
    selectOnly(toRel(selectedFilePath));
  }, [selectedFilePath, selectOnly, toRel]);

  // Trees only sorts on insert/reset, but date-modified order shifts as
  // lazily-hydrated stats arrive and as files are saved. Re-sort via
  // resetPaths when any stat changes, preserving expansion and selection.
  // (The name sorts don't depend on stats, so they never need this.)
  const lastStatSignatureRef = useRef<string | null>(null);
  useEffect(() => {
    if (sortOrder !== "date-modified") return;
    const map = entry.sortState.modifiedByRelPath;
    const signature = treePaths
      .map((p) => {
        const canonical = p.replace(/\/+$/, "");
        return `${canonical}:${map.get(canonical) ?? 0}`;
      })
      .sort()
      .join("\n");
    if (signature === lastStatSignatureRef.current) return;

    // Never yank an in-progress inline edit (rename/create): retry on the
    // next data tick instead by leaving the signature unrecorded.
    const container = model.getFileTreeContainer();
    if (container?.shadowRoot?.querySelector("[data-item-rename-input]")) {
      return;
    }
    lastStatSignatureRef.current = signature;

    resetModelPaths(treePaths);
  }, [treePaths, fileMetadataList, sortOrder, entry, model, resetModelPaths]);

  // Map the externally-owned FileTreeMode onto trees' built-in editing flows,
  // then release the mode immediately: trees owns the edit session itself.
  // fallow-ignore-next-line complexity
  useEffect(() => {
    if (mode.type === "renaming") {
      model.startRenaming(toRel(mode.path));
      onModeChange(FILE_TREE_IDLE);
    } else if (mode.type === "creating") {
      const parentRel =
        mode.parentPath === basePath ? "" : toRel(mode.parentPath);
      let name = mode.itemType === "file" ? "untitled.md" : "untitled";
      let candidate = parentRel ? `${parentRel}/${name}` : name;
      let counter = 2;
      while (model.getItem(candidate)) {
        name =
          mode.itemType === "file"
            ? `untitled-${counter}.md`
            : `untitled-${counter}`;
        candidate = parentRel ? `${parentRel}/${name}` : name;
        counter += 1;
      }
      if (parentRel) {
        const parent = model.getItem(parentRel);
        if (parent && "expand" in parent) parent.expand();
      }
      model.add(mode.itemType === "directory" ? `${candidate}/` : candidate);
      entry.pendingCreate = { path: candidate, itemType: mode.itemType };
      model.scrollToPath(candidate);
      model.startRenaming(candidate, { removeIfCanceled: true });
      onModeChange(FILE_TREE_IDLE);
    }
  }, [mode, entry, model, basePath, toRel, onModeChange]);

  const renderContextMenu = useCallback(
    (item: ContextMenuItem, context: ContextMenuOpenContext) => {
      const abs = toAbs(item.path);
      // App-owned paths (.metrists and its scratchpads folder) can't be
      // renamed or deleted; creating files inside them stays allowed.
      const isProtected = isProtectedTreePath(item.path.replace(/\/+$/, ""));
      // Mirrors ui/context-menu.tsx's ContextMenuItem styling (this menu is
      // hand-rolled — @pierre/trees owns its rendering) so the file tree and
      // the sessions panel read as the same menu.
      const menuButton =
        "flex w-full items-center gap-2 whitespace-nowrap rounded-sm px-1.5 py-1 text-left text-xs hover:bg-accent hover:text-accent-foreground disabled:opacity-50 [&_svg]:size-3.5 [&_svg]:shrink-0";
      return (
        <div
          role="menu"
          className="w-max min-w-[7rem] rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
          data-file-tree-context-menu-root="true"
        >
          {item.kind === "file" && (
            <button
              type="button"
              role="menuitem"
              className={menuButton}
              onClick={() => {
                context.close();
                openFileAtPath(item.path, { intent: "new-tab" });
              }}
            >
              <ExternalLink />
              {t("openInNewTab", "Open in New Tab")}
            </button>
          )}
          {item.kind === "directory" && (
            <>
              <button
                type="button"
                role="menuitem"
                className={menuButton}
                onClick={() => {
                  context.close();
                  onModeChange({
                    type: "creating",
                    parentPath: abs,
                    itemType: "file",
                  });
                }}
              >
                <FilePlus />
                {t("newFile", "New File")}
              </button>
              <button
                type="button"
                role="menuitem"
                className={menuButton}
                onClick={() => {
                  context.close();
                  onModeChange({
                    type: "creating",
                    parentPath: abs,
                    itemType: "directory",
                  });
                }}
              >
                <FolderPlus />
                {t("newFolder", "New Folder")}
              </button>
            </>
          )}
          {!isProtected && (
            <>
              <button
                type="button"
                role="menuitem"
                className={menuButton}
                // Scratchpads may be renamed while open (naming = promotion,
                // via the close-and-reopen primitive).
                disabled={
                  isPathOpenInTab(abs) && !isScratchpadPath(basePath, abs)
                }
                onClick={() => {
                  model.startRenaming(item.path);
                  context.close({ restoreFocus: false });
                }}
              >
                <PenLine />
                {t("rename", "Rename")}
              </button>
              <div role="separator" className="-mx-1 my-1 h-px bg-border" />
              <button
                type="button"
                role="menuitem"
                className={`${menuButton} text-destructive`}
                onClick={() => {
                  context.close();
                  setPendingDelete({ path: abs, type: item.kind });
                }}
              >
                <Trash2 />
                {t("delete", "Delete")}
              </button>
            </>
          )}
        </div>
      );
    },
    [toAbs, openFileAtPath, onModeChange, isPathOpenInTab, model, t],
  );

  const handleHostKeyDown = useCallback<
    NonNullable<TreesFileTreeProps["onKeyDown"]>
  >(
    // fallow-ignore-next-line complexity
    (event) => {
      if (event.key === "Enter") {
        const inEditable = event.nativeEvent
          .composedPath()
          .some((t) => t instanceof HTMLInputElement);
        if (!inEditable) {
          const focused = model.getFocusedItem();
          if (focused && !focused.isDirectory()) {
            openFileAtPath(focused.getPath());
          }
        }
        return;
      }
      if (
        onDelete &&
        event.key === "Backspace" &&
        (event.metaKey || event.ctrlKey)
      ) {
        const focused = model.getFocusedItem();
        if (
          focused &&
          !isProtectedTreePath(focused.getPath().replace(/\/+$/, ""))
        ) {
          event.preventDefault();
          setPendingDelete({
            path: toAbs(focused.getPath()),
            type: focused.isDirectory() ? "directory" : "file",
          });
        }
      }
    },
    [onDelete, model, toAbs, openFileAtPath],
  );

  // Protocol drops (dnd-kit pointer drags, e.g. dragging an image out of the
  // editor) can't target shadow-DOM rows, so the whole tree is one dropzone
  // and the destination folder comes from hit-testing the drop point.
  const treeDrop = dropZoneProps({
    accepts: ["image-asset"],
    dropEffect: "move",
    onDrop: (payload, info) => {
      let destDir = basePath;
      const container = model.getFileTreeContainer();
      const hit = container?.shadowRoot?.elementFromPoint(
        info.position.x,
        info.position.y,
      );
      const rowEl = hit?.closest<HTMLElement>("[data-item-path]");
      const rel = rowEl?.dataset.itemPath;
      if (rel) {
        destDir =
          rowEl?.dataset.itemType === "folder"
            ? toAbs(rel)
            : getDirectoryPath(toAbs(rel));
      }
      moveIntoFolder(payload, destDir);
    },
  });

  return (
    <div
      className={cn(
        "min-h-0 grow transition-colors",
        "data-[mtr-drop-over=true]:shadow-[0_0_0_1px_hsl(var(--ring))_inset]",
        "data-[mtr-drop-over=true]:bg-[hsl(var(--ring)/0.06)]",
      )}
      data-mtr-dropzone={treeDrop["data-mtr-dropzone"]}
      ref={treeDrop.ref}
    >
      <TreesFileTree
        model={model}
        renderContextMenu={renderContextMenu}
        onClick={handleHostClick}
        onClickCapture={handleHostClickCapture}
        onKeyDown={handleHostKeyDown}
        onMouseOver={handleHostMouseOver}
        onDragStart={handleHostDragStart}
        onFocus={handleHostFocus}
        tabIndex={-1}
        data-focus-key="sidebar-first-file-item"
        style={{ height: "100%" }}
      />

      {pendingDelete && (
        <AlertDialog
          open
          onOpenChange={(open) => {
            if (!open) setPendingDelete(null);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {t("deleteConfirmTitle", 'Delete "{{name}}"?', {
                  name: getFileName(pendingDelete.path),
                })}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {pendingDelete.type === "directory"
                  ? t(
                      "deleteDirectoryConfirm",
                      "This will permanently delete the folder and all its contents. This action cannot be undone.",
                    )
                  : t(
                      "deleteFileConfirm",
                      "This will permanently delete the file. This action cannot be undone.",
                    )}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel onClick={() => setPendingDelete(null)}>
                {t("cancel", "Cancel")}
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  if (pendingDelete && onDelete) {
                    onDelete(pendingDelete.path);
                  }
                  setPendingDelete(null);
                }}
              >
                {t("delete", "Delete")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  );
}
