import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { IconSidebar } from "@/components/editor/icon-sidebar";
import { FileTree } from "@/components/editor/file-tree";
import { FileControls } from "@/components/editor/file-controls";
import { TabBar, type Tab } from "@/components/editor/tab-bar";
import { TextEditor } from "@/components/editor/text-editor";
import { StatusBar } from "@/components/editor/status-bar";
import { SettingsModal } from "@/components/editor/settings-modal";
import { CommandPalette } from "@/components/editor/command-palette";
import { getSingltonStore } from "../utils/tinybase";
import { useWorkspaceParams } from "@/hooks/use-workspace-params";
import { useTranslation } from "react-i18next";
import { FileTreeNode } from "@/utils/fs";

const initialFiles: FileTreeNode[] = [
  {
    path: "Welcome.md",
    type: "file",
    contentHash: "",
    content: "",
  },
  {
    path: "Projects",
    type: "directory",
    contentHash: "",
    content: "",
    children: [
      {
        path: "Projects/Project A.md",
        type: "file",
        contentHash: "",
        content: "",
      },
      {
        path: "Projects/Project B.md",
        type: "file",
        contentHash: "",
        content: "",
      },
    ],
  },
  {
    path: "Notes",
    type: "directory",
    contentHash: "",
    content: "",
    children: [
      {
        path: "Notes/Meeting Notes.md",
        type: "file",
        contentHash: "",
        content: "",
      },
      {
        path: "Notes/Ideas.md",
        type: "file",
        contentHash: "",
        content: "",
      },
    ],
  },
];

const initialContents: Record<string, string> = {
  "Welcome.md":
    "# Welcome to the Editor\n\nThis is a simple file editor with a collapsible file tree, tab bar, and text editing experience.\n\n## Features\n- Collapsible and resizable file tree\n- Tab management with close buttons\n- Word and character count\n- Sync status indicator\n\nStart by selecting a file from the sidebar or creating a new one!",
  "Projects/Project A.md": "# Project A\n\nProject description goes here...",
  "Projects/Project B.md": "# Project B\n\nProject description goes here...",
  "Notes/Meeting Notes.md":
    "# Meeting Notes\n\n## Attendees\n- Person 1\n- Person 2\n\n## Agenda\n1. Item 1\n2. Item 2",
  "Notes/Ideas.md": "# Ideas\n\n- Idea 1\n- Idea 2\n- Idea 3",
};

export const Workspace = () => {
  const { t } = useTranslation();

  const [activeSidebarItem, setActiveSidebarItem] = useState("files");
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(240);
  const [files] = useState<FileTreeNode[]>(initialFiles);
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(
    "Welcome.md",
  );
  const [tabs, setTabs] = useState<Tab[]>([
    { id: "Welcome.md", name: "Welcome", isModified: false },
  ]);
  const [activeTabId, setActiveTabId] = useState<string | null>("Welcome.md");
  const [fileContents, setFileContents] =
    useState<Record<string, string>>(initialContents);
  const [isSynced, setIsSynced] = useState(true);
  const [isResizing, setIsResizing] = useState(false);
  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false);
  const [direction, setDirection] = useState<"ltr" | "rtl">("ltr");
  const resizeRef = useRef<HTMLDivElement>(null);

  const currentContent = activeTabId ? fileContents[activeTabId] || "" : "";
  const currentTitle = tabs.find((t) => t.id === activeTabId)?.name || "";

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

  // Handle resize
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

  const handleFileSelect = useCallback((file: FileTreeNode) => {
    if (file.type === "file") {
      setSelectedFilePath(file.path);
      setTabs((prev) => {
        const existingTab = prev.find((t) => t.id === file.path);
        if (existingTab) {
          return prev;
        }
        const fileName = file.path.split("/").pop() || file.path;
        return [...prev, { id: file.path, name: fileName, isModified: false }];
      });
      setActiveTabId(file.path);
    }
  }, []);

  const handleTabSelect = useCallback((tabId: string) => {
    setActiveTabId(tabId);
    setSelectedFilePath(tabId);
  }, []);

  const handleTabClose = useCallback(
    (tabId: string) => {
      setTabs((prev) => {
        const newTabs = prev.filter((t) => t.id !== tabId);
        if (activeTabId === tabId && newTabs.length > 0) {
          setActiveTabId(newTabs[newTabs.length - 1].id);
          setSelectedFilePath(newTabs[newTabs.length - 1].id);
        } else if (newTabs.length === 0) {
          setActiveTabId(null);
          setSelectedFilePath(null);
        }
        return newTabs;
      });
    },
    [activeTabId],
  );

  const handleNewTab = useCallback(() => {
    const newId = `new-${Date.now()}`;
    const newTab: Tab = {
      id: newId,
      name: t("untitled"),
      isModified: true,
    };
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(newId);
    setFileContents((prev) => ({ ...prev, [newId]: "" }));
  }, [t]);

  const handleNewFile = useCallback(() => {
    handleNewTab();
  }, [handleNewTab]);

  const handleContentChange = useCallback(
    (content: string) => {
      if (!activeTabId) return;

      setFileContents((prev) => ({ ...prev, [activeTabId]: content }));
      setTabs((prev) =>
        prev.map((t) =>
          t.id === activeTabId ? { ...t, isModified: true } : t,
        ),
      );
      setIsSynced(false);

      // Simulate sync after a delay
      setTimeout(() => setIsSynced(true), 1500);
    },
    [activeTabId],
  );

  return (
    <div
      dir={direction}
      className="flex h-screen w-screen bg-background overflow-hidden"
    >
      {/* Icon Sidebar */}
      <IconSidebar
        activeItem={activeSidebarItem}
        onItemClick={setActiveSidebarItem}
        onCommandPaletteClick={() => setIsCommandPaletteOpen(true)}
      />

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Top Bar with File Controls and Tab Bar */}
        <div className="flex items-stretch border-b border-border shrink-0">
          {/* File Controls - synced width with file tree */}
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

          {/* Tab Bar */}
          <div className="flex-1 min-w-0 overflow-hidden">
            <TabBar
              tabs={tabs}
              activeTabId={activeTabId}
              onTabSelect={handleTabSelect}
              onTabClose={handleTabClose}
              onNewTab={handleNewTab}
            />
          </div>
        </div>

        {/* Content Area */}
        <div className="flex-1 flex min-h-0 overflow-hidden">
          {/* File Tree Panel */}
          {!isSidebarCollapsed && (
            <>
              <div
                className="shrink-0 bg-sidebar flex flex-col"
                style={{ width: sidebarWidth }}
              >
                <FileTree
                  selectedFilePath={selectedFilePath}
                  onFileSelect={handleFileSelect}
                />
              </div>
              {/* Resize Handle */}
              <div
                ref={resizeRef}
                onMouseDown={handleResizeStart}
                className="w-1 shrink-0 bg-border hover:bg-primary/50 cursor-col-resize transition-colors"
              />
            </>
          )}

          {/* Editor Panel */}
          <div className="flex-1 min-w-0 overflow-hidden">
            {activeTabId ? (
              <TextEditor
                content={currentContent}
                onChange={handleContentChange}
                title={currentTitle}
              />
            ) : (
              <div className="flex items-center justify-center h-full text-muted-foreground p-4">
                <p className="text-center">{t("noFileSelected")}</p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Status Bar */}
      <StatusBar
        wordCount={wordCount}
        characterCount={characterCount}
        isSynced={isSynced}
      />

      {/* Settings Modal */}
      <SettingsModal direction={direction} onDirectionChange={setDirection} />

      {/* Command Palette */}
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
