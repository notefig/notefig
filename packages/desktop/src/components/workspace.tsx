import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { useHotkey } from "@tanstack/react-hotkeys";
import { Dockable } from "@/components/dockable";
import { IconSidebar } from "@/components/editor/icon-sidebar";
import { Sidebar } from "@/components/editor/sidebar";
import { TextEditor } from "@/components/editor/text-editor";
import { StatusBar } from "@/components/editor/status-bar";
import { SettingsModal } from "@/components/editor/settings-modal";
import { CommandPalette } from "@/components/editor/command-palette";
import { useTranslation } from "react-i18next";
import { getOrCreateWorkspaceCollections } from "@/utils/collections";
import { useLiveQuery, eq, inArray } from "@tanstack/react-db";
import { DebugPanel } from "./debug-panel";
import { useWorkspaceParams } from "@/hooks/use-workspace-params";
import { useDockableTabs } from "@/hooks/use-dockable-tabs";
import type { FileEntry } from "@/utils/fs";
import { getFileName, isTextFile } from "@/utils/fs";
import { removeTabFromLayout } from "@/utils/dockable-layout";
import { platformAdapter } from "@/adapters";
import {
  handleMetadataFileSystemChange,
  handleContentFileSystemChange,
} from "@/utils/file-sync";
import { disposeAllEditors } from "@/components/editor/editor-store";
import { useSearchParams } from "react-router";
import {
  type FileTreeMode,
  FILE_TREE_IDLE,
} from "@/components/editor/file-tree";

export const Workspace = () => {
  const { workspacePath } = useWorkspaceParams();

  if (!workspacePath) {
    return null;
  }

  const { metadata, content } = getOrCreateWorkspaceCollections(workspacePath);
  const { t } = useTranslation();
  const dockableRef = useRef<HTMLDivElement>(null);

  const {
    layout,
    openTabs,
    activeTabId,
    handleFileSelect,
    handleLayoutChange,
    closeTab,
  } = useDockableTabs({
    renderTabs: () => [],
    canOpenFile: (file) => file.type === "file" && isTextFile(file.path),
    dockableRef,
  });

  useEffect(() => {
    return () => {
      disposeAllEditors();
    };
  }, []);

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
    [workspacePath, ...openTabs],
  );

  // Build Dockable tabs
  const dockableTabs = useMemo(
    () =>
      fileDataWithContent.map((fileEntry) => (
        <Dockable.Tab
          key={fileEntry.path}
          id={fileEntry.path}
          name={getFileName(fileEntry.path)}
          onClose={() => {
            const nextLayout = removeTabFromLayout(layout, fileEntry.path);
            handleLayoutChange(nextLayout);
          }}
        >
          <TextEditor file={fileEntry as FileEntry} basePath={workspacePath} />
        </Dockable.Tab>
      )),
    [fileDataWithContent, workspacePath, layout, handleLayoutChange],
  );

  const activeFileData = fileDataWithContent.find(
    (f) => f.path === activeTabId,
  );
  const currentContent = activeFileData?.content || "";

  const [searchParams, setSearchParams] = useSearchParams();
  const isSidebarCollapsed = searchParams.get("sidebar") === "collapsed";
  const toggleSidebarCollapsed = useCallback(() => {
    setSearchParams((prev) => {
      if (prev.get("sidebar") === "collapsed") {
        prev.delete("sidebar");
      } else {
        prev.set("sidebar", "collapsed");
      }
      return prev;
    });
  }, [setSearchParams]);
  const [isSynced] = useState(true);
  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false);
  const [direction, setDirection] = useState<"ltr" | "rtl">("ltr");

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

  const [fileTreeMode, setFileTreeMode] =
    useState<FileTreeMode>(FILE_TREE_IDLE);

  const handleNewFile = useCallback(() => {
    setFileTreeMode({
      type: "creating",
      parentPath: workspacePath,
      itemType: "file",
    });
  }, [workspacePath]);

  useHotkey("Mod+N", () => {
    handleNewFile();
  });

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

  return (
    <div
      dir={direction}
      className="flex h-full w-full bg-background overflow-hidden"
    >
      <IconSidebar
        onCommandPaletteClick={() => setIsCommandPaletteOpen(true)}
        isCollapsed={isSidebarCollapsed}
        onToggleCollapse={toggleSidebarCollapsed}
      />

      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <DebugPanel />

        <div className="flex-1 flex min-h-0 overflow-hidden">
          {!isSidebarCollapsed && (
            <Sidebar
              workspacePath={workspacePath}
              activeTabId={activeTabId}
              openTabs={openTabs}
              onFileSelect={handleFileSelect}
              closeTab={closeTab}
              mode={fileTreeMode}
              onModeChange={setFileTreeMode}
            />
          )}

          <div
            ref={dockableRef}
            className="flex-1 min-w-0 h-full overflow-hidden"
          >
            {openTabs.length === 0 || dockableTabs.length === 0 ? (
              <div className="flex items-center justify-center h-full text-muted-foreground p-4 ps-0">
                <p className="text-center">{t("noFileSelected")}</p>
              </div>
            ) : (
              <Dockable.Root
                orientation="row"
                layout={layout}
                onChange={handleLayoutChange}
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
        onToggleSidebar={toggleSidebarCollapsed}
        direction={direction}
      />
    </div>
  );
};
