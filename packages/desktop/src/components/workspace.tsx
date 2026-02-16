import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useSearchParams } from "react-router";
import { IconSidebar } from "@/components/editor/icon-sidebar";
import { FileTree } from "@/components/editor/file-tree";
import { FileControls } from "@/components/editor/file-controls";
import { TabBar } from "@/components/editor/tab-bar";
import { TextEditor } from "@/components/editor/text-editor";
import { StatusBar } from "@/components/editor/status-bar";
import { SettingsModal } from "@/components/editor/settings-modal";
import { CommandPalette } from "@/components/editor/command-palette";
import { useTranslation } from "react-i18next";
import {
  getOrCreateWorkspaceCollections,
  getFileEntry,
} from "@/utils/collections";
import { useLiveQuery, eq, inArray, or } from "@tanstack/react-db";
import { DebugPanel } from "./debug-panel";
import { useWorkspaceParams } from "@/hooks/use-workspace-params";
import type { FileTreeNode, FileEntry } from "@/utils/fs";
import { cn } from "../lib/utils";

export const Workspace = () => {
  const { workspacePath } = useWorkspaceParams();

  // Early return if no workspace path
  if (!workspacePath) {
    return null;
  }

  const { metadata, content } = getOrCreateWorkspaceCollections(workspacePath);
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();

  const activeTabId = searchParams.get("activeTab");
  const openTabs = searchParams.getAll("tab");

  // Single reactive query: Join metadata + content for open tabs
  // The where clause on content triggers on-demand loading via queryFn
  const { data: fileDataWithContent = [], isError: isQueryError } =
    useLiveQuery(
      (q) =>
        openTabs.length === 0
          ? undefined // No tabs open - useLiveQuery handles undefined gracefully
          : q
              .from({ file: metadata })
              .where(({ file }) => inArray(file.path, openTabs))
              // ✅ Explicitly constrain content to trigger on-demand loading
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
      .filter((word) => word.length > 0);
    return {
      wordCount: words.length,
      characterCount: currentContent.length,
    };
  }, [currentContent]);

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

  const handleFileSelect = useCallback(
    (file: FileTreeNode) => {
      if (file.type === "file") {
        setSearchParams((prev) => {
          const currentTabs = prev.getAll("tab");
          const newParams = new URLSearchParams(prev);
          if (!currentTabs.includes(file.path)) {
            newParams.append("tab", file.path);
          }
          newParams.set("activeTab", file.path);
          return newParams;
        });
      }
    },
    [setSearchParams],
  );

  const handleNewTab = useCallback(() => {
    //TODO: handle new tab + new file creation
  }, [t]);

  const handleNewFile = useCallback(() => {
    //TODO: handle new tab + new file creation
  }, [handleNewTab]);

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
        <DebugPanel isEditRoute={true} />
        <div className="flex items-stretch border-b border-border shrink-0">
          <div
            className="shrink-0 border-r rtl:border-r-0 rtl:border-l border-border"
            style={{ width: isSidebarCollapsed ? "auto" : sidebarWidth }}
          >
            <FileControls
              isCollapsed={isSidebarCollapsed}
              onToggleCollapse={() =>
                setIsSidebarCollapsed(!isSidebarCollapsed)
              }
              onNewFile={handleNewFile}
              onNewFolder={() => {}}
            />
          </div>

          <div className="flex-1 min-w-0 overflow-hidden">
            <TabBar onNewTab={handleNewTab} />
          </div>
        </div>

        <div className="flex-1 flex min-h-0 overflow-hidden">
          {!isSidebarCollapsed && (
            <>
              <div
                className="shrink-0 bg-sidebar flex flex-col"
                style={{ width: sidebarWidth }}
              >
                <FileTree
                  selectedFilePath={null}
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

          <div className="flex-1 min-w-0 overflow-hidden">
            {openTabs.length === 0 ? (
              <div className="flex items-center justify-center h-full text-muted-foreground p-4">
                <p className="text-center">{t("noFileSelected")}</p>
              </div>
            ) : (
              <>
                {fileDataWithContent.map((fileEntry) => (
                  <div
                    key={fileEntry.path}
                    className={cn(
                      "h-full",
                      fileEntry.path === activeTabId ? "block" : "hidden",
                    )}
                  >
                    <TextEditor
                      key={fileEntry.path}
                      file={fileEntry as FileEntry}
                      basePath={workspacePath}
                      isActive={fileEntry.path === activeTabId}
                    />
                  </div>
                ))}
              </>
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
