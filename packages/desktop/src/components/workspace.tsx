import {
  useState,
  useEffect,
  useRef,
  useMemo,
  useCallback,
  type ReactElement,
} from "react";
import { Dockable } from "@danfessler/react-dockable";
import type { LayoutNode, TabProps } from "@danfessler/react-dockable";
import { IconSidebar } from "@/components/editor/icon-sidebar";
import { FileTree } from "@/components/editor/file-tree";
import { FileControls } from "@/components/editor/file-controls";
import { TextEditor } from "@/components/editor/text-editor";
import { StatusBar } from "@/components/editor/status-bar";
import { SettingsModal } from "@/components/editor/settings-modal";
import { CommandPalette } from "@/components/editor/command-palette";
import { useTranslation } from "react-i18next";
import { getOrCreateWorkspaceCollections } from "@/utils/collections";
import { useLiveQuery, eq, inArray } from "@tanstack/react-db";
import { DebugPanel } from "./debug-panel";
import { useWorkspaceParams } from "@/hooks/use-workspace-params";
import { useLayoutSearchParam } from "@/hooks/use-layout-search-param";
import type { FileTreeNode, FileEntry } from "@/utils/fs";
import { platformAdapter } from "@/adapters";
import {
  handleMetadataFileSystemChange,
  handleContentFileSystemChange,
} from "@/utils/file-sync";
import { getFileName } from "@/utils/fs";
import {
  disposeEditor,
  disposeAllEditors,
} from "@/components/editor/editor-store";

// ── Dockable layout helpers ─────────────────────────────────────────────────

/**
 * Deep-clone a layout tree, adding a new tab to the first Window and selecting it.
 * Preserves all panel splits, sizes, and tab ordering.
 */
function addTabToLayout(layout: LayoutNode[], tabId: string): LayoutNode[] {
  let added = false;
  function walk(nodes: LayoutNode[]): LayoutNode[] {
    return nodes.map((node) => {
      if (node.type === "Window" && !added) {
        added = true;
        return {
          ...node,
          children: [...node.children, tabId],
          selected: tabId,
        };
      }
      if (node.type === "Panel") {
        return { ...node, children: walk(node.children) };
      }
      return node;
    });
  }
  return walk(layout);
}

/**
 * Deep-clone a layout tree, setting `selected` to `tabId` in the Window
 * that contains it. Other windows are left unchanged.
 */
function selectTabInLayout(layout: LayoutNode[], tabId: string): LayoutNode[] {
  return layout.map((node) => {
    if (node.type === "Window") {
      if (node.children.includes(tabId)) {
        return { ...node, selected: tabId };
      }
      return node;
    }
    if (node.type === "Panel") {
      return { ...node, children: selectTabInLayout(node.children, tabId) };
    }
    return node;
  });
}

/**
 * Walk the LayoutNode tree and collect all tab IDs.
 * (Used locally to diff tabs on Dockable onChange.)
 */
function extractTabIds(nodes: LayoutNode[]): string[] {
  const ids: string[] = [];
  for (const node of nodes) {
    if (node.type === "Window") {
      ids.push(...node.children);
    } else if (node.type === "Panel") {
      ids.push(...extractTabIds(node.children));
    }
  }
  return ids;
}

// ── Workspace Component ─────────────────────────────────────────────────────

export const Workspace = () => {
  const { workspacePath } = useWorkspaceParams();

  // Early return if no workspace path
  if (!workspacePath) {
    return null;
  }

  const { metadata, content } = getOrCreateWorkspaceCollections(workspacePath);
  const { t } = useTranslation();

  // ── Layout state from URL (single source of truth) ──
  const { layout, setLayout, openTabs, activeTabId } = useLayoutSearchParam();

  // Track the previous set of open tab IDs so we can detect structural
  // changes (tab added / removed) vs. selection-only changes.
  // Dockable.Root reads `layout` only on mount, so we must remount it
  // (via key change) whenever the set of tabs changes.
  const prevTabKeyRef = useRef(openTabs.join(","));
  const dockableKey = useMemo(() => {
    const key = openTabs.join(",");
    if (key !== prevTabKeyRef.current) {
      prevTabKeyRef.current = key;
    }
    return key;
  }, [openTabs]);

  // Dispose all editor instances when this workspace unmounts
  // (e.g. user navigates to a different workspace)
  useEffect(() => {
    return () => {
      disposeAllEditors();
    };
  }, []);

  // Single reactive query: Join metadata + content for open tabs
  const { data: fileDataWithContent = [] } = useLiveQuery(
    (q) =>
      openTabs.length === 0
        ? undefined
        : q
            .from({ file: metadata })
            .where(({ file }) => inArray(file.path, openTabs))
            .join({ content }, ({ file, content }) =>
              eq(file.path, content.path),
            )
            .where(({ content }) => inArray(content?.path, openTabs))
            .select(({ file, content }) => ({
              ...file,
              content: content?.content,
              contentHash: content?.contentHash,
            })),
    [...openTabs, activeTabId],
  );

  // Get current content for status bar from active tab
  const activeFileData = fileDataWithContent.find(
    (f) => f.path === activeTabId,
  );
  const currentContent = activeFileData?.content || "";

  // ── UI state ──
  const [activeSidebarItem, setActiveSidebarItem] = useState("files");
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(240);
  const [isSynced, setIsSynced] = useState(true);
  const [isResizing, setIsResizing] = useState(false);
  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false);
  const [direction, setDirection] = useState<"ltr" | "rtl">("ltr");
  const resizeRef = useRef<HTMLDivElement>(null);

  const { wordCount, characterCount } = useMemo(() => {
    const words = currentContent
      .trim()
      .split(/\s+/)
      .filter((word: string) => word.length > 0);
    return {
      wordCount: words.length,
      characterCount: currentContent.length,
    };
  }, [currentContent]);

  // ── Sidebar resize ──
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing) return;
      const iconSidebarWidth = 48;
      const newWidth = e.clientX - iconSidebarWidth;
      const clampedWidth = Math.max(150, Math.min(400, newWidth));
      setSidebarWidth(clampedWidth);
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    if (isResizing) {
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    }

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [isResizing]);

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
  }, []);

  // ── File selection (updates layout in URL) ──
  const handleFileSelect = useCallback(
    (file: FileTreeNode) => {
      if (file.type !== "file") return;

      if (openTabs.includes(file.path)) {
        // Tab already open — update selection in the layout.
        // This causes a Dockable remount only if the key changes,
        // which it won't (same set of tabs). So Dockable picks up
        // the new `selected` value on its next mount.
        // NOTE: Dockable doesn't re-read layout after mount, so
        // selection-only changes update the URL but don't visually
        // switch the tab inside Dockable. The user switches via
        // Dockable's own tab bar. We still write to the URL so the
        // activeTabId derived state is correct (for status bar etc.).
        setLayout(selectTabInLayout(layout, file.path));
        return;
      }

      // New tab: merge into the current layout
      let nextLayout: LayoutNode[];
      if (layout.length > 0) {
        nextLayout = addTabToLayout(layout, file.path);
      } else {
        // First tab ever — create a fresh single-window layout
        nextLayout = [
          {
            type: "Window" as const,
            id: "editor-window",
            children: [file.path],
            selected: file.path,
            size: 1,
          },
        ];
      }

      setLayout(nextLayout);
    },
    [layout, openTabs, setLayout],
  );

  const handleNewFile = useCallback(() => {
    //TODO: handle new tab + new file creation
  }, []);

  // ── Dockable onChange: write updated layout back to the URL ──
  const handleDockableChange = useCallback(
    (newLayout: LayoutNode[]) => {
      // Dispose editors for any tabs that Dockable removed (e.g. via drag)
      const newTabIds = extractTabIds(newLayout);
      const removed = openTabs.filter((id) => !newTabIds.includes(id));
      removed.forEach((id) => disposeEditor(id));

      // Write the full layout to the URL
      setLayout(newLayout);
    },
    [openTabs, setLayout],
  );

  // ── File watchers ──
  useEffect(() => {
    const metadataWatchId = `metadata-${workspacePath}`;
    const contentWatchId = `content-${workspacePath}`;
    let eventCleanup: (() => void) | undefined;

    const setupWatchers = async () => {
      eventCleanup = platformAdapter.addEventListener((event) => {
        if (event.type === "fs-metadata-changed") {
          handleMetadataFileSystemChange(event.payload, workspacePath);
        } else if (event.type === "fs-content-changed") {
          handleContentFileSystemChange(event.payload, workspacePath);
        }
      });

      await platformAdapter.startWatchingMetadata(
        [workspacePath],
        metadataWatchId,
      );

      if (openTabs.length > 0) {
        await platformAdapter.startWatchingContent(openTabs, contentWatchId);
      }
    };

    setupWatchers();

    return () => {
      eventCleanup?.();
      platformAdapter.stopWatching(metadataWatchId);
      if (openTabs.length > 0) {
        platformAdapter.stopWatching(contentWatchId);
      }
    };
  }, [workspacePath, openTabs.join(",")]);

  // ── Build Dockable tabs ──
  const dockableTabs: ReactElement<TabProps>[] = fileDataWithContent.map(
    (fileEntry) => (
      <Dockable.Tab
        key={fileEntry.path}
        id={fileEntry.path}
        name={getFileName(fileEntry.path)}
      >
        <TextEditor
          file={fileEntry as FileEntry}
          basePath={workspacePath}
          isActive={fileEntry.path === activeTabId}
        />
      </Dockable.Tab>
    ),
  );

  return (
    <div
      dir={direction}
      className="flex h-screen w-screen bg-background overflow-hidden"
    >
      <IconSidebar
        activeItem={activeSidebarItem}
        onItemClick={setActiveSidebarItem}
        onCommandPaletteClick={() => setIsCommandPaletteOpen(true)}
      />

      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <DebugPanel
          isEditRoute={true}
          openTabs={openTabs}
          activeTabId={activeTabId}
          dockableLayout={layout}
        />

        <div className="flex-1 flex min-h-0 overflow-hidden">
          {/* ── File tree sidebar ── */}
          {!isSidebarCollapsed && (
            <>
              <div
                className="shrink-0 bg-sidebar flex flex-col border-r border-border"
                style={{ width: sidebarWidth }}
              >
                <FileControls
                  isCollapsed={isSidebarCollapsed}
                  onToggleCollapse={() =>
                    setIsSidebarCollapsed(!isSidebarCollapsed)
                  }
                  onNewFile={handleNewFile}
                  onNewFolder={() => {}}
                />
                <FileTree
                  selectedFilePath={activeTabId}
                  onFileSelect={handleFileSelect}
                  basePath={workspacePath!}
                />
              </div>
              <div
                ref={resizeRef}
                onMouseDown={handleResizeStart}
                className="w-1 shrink-0 bg-border hover:bg-primary/50 cursor-col-resize transition-colors"
              />
            </>
          )}

          {/* ── Editor area (Dockable) ── */}
          <div className="flex-1 min-w-0 h-full overflow-hidden">
            {openTabs.length === 0 || dockableTabs.length === 0 ? (
              <div className="flex items-center justify-center h-full text-muted-foreground p-4">
                <p className="text-center">{t("noFileSelected")}</p>
              </div>
            ) : (
              <Dockable.Root
                key={dockableKey}
                orientation="row"
                layout={layout}
                onChange={handleDockableChange}
              >
                {dockableTabs}
              </Dockable.Root>
            )}
          </div>
        </div>
      </div>

      <StatusBar
        wordCount={wordCount}
        characterCount={characterCount}
        isSynced={isSynced}
      />

      <SettingsModal direction={direction} onDirectionChange={setDirection} />

      <CommandPalette
        open={isCommandPaletteOpen}
        onOpenChange={setIsCommandPaletteOpen}
        onNewFile={handleNewFile}
        onOpenSettings={() => {
          setIsCommandPaletteOpen(false);
        }}
        onToggleSidebar={() => setIsSidebarCollapsed(!isSidebarCollapsed)}
        direction={direction}
      />
    </div>
  );
};
