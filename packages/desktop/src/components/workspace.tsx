import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useParams, useSearchParams, useNavigate } from "react-router-dom";
import { IconSidebar } from "@/components/editor/icon-sidebar";
import { FileTree, type FileNode } from "@/components/editor/file-tree";
import { FileControls } from "@/components/editor/file-controls";
import { TabBar, type Tab } from "@/components/editor/tab-bar";
import { TextEditor } from "@/components/editor/text-editor";
import { StatusBar } from "@/components/editor/status-bar";
import { SettingsModal } from "@/components/editor/settings-modal";
import { CommandPalette } from "@/components/editor/command-palette";
import { getSingltonStore } from "../utils/tinybase";

const initialFiles: FileNode[] = [
  {
    id: "5",
    name: "Welcome",
    type: "file",
  },
  {
    id: "folder-1",
    name: "Projects",
    type: "folder",
    children: [
      { id: "6", name: "Project A", type: "file" },
      { id: "7", name: "Project B", type: "file" },
    ],
  },
  {
    id: "folder-2",
    name: "Notes",
    type: "folder",
    children: [
      { id: "8", name: "Meeting Notes", type: "file" },
      { id: "9", name: "Ideas", type: "file" },
    ],
  },
];

const initialContents: Record<string, string> = {
  "1": "# 2026-01-17\n\nThis is my daily note for January 17th, 2026.\n\n## Tasks\n- [ ] Review project proposals\n- [ ] Team meeting at 2pm\n- [ ] Complete documentation\n\n## Notes\nStart typing here...",
  "2": "",
  "3": "",
  "4": "",
  "5": "# Welcome to the Editor\n\nThis is a simple file editor with a collapsible file tree, tab bar, and text editing experience.\n\n## Features\n- Collapsible and resizable file tree\n- Tab management with close buttons\n- Word and character count\n- Sync status indicator\n\nStart by selecting a file from the sidebar or creating a new one!",
  "6": "# Project A\n\nProject description goes here...",
  "7": "# Project B\n\nProject description goes here...",
  "8": "# Meeting Notes\n\n## Attendees\n- Person 1\n- Person 2\n\n## Agenda\n1. Item 1\n2. Item 2",
  "9": "# Ideas\n\n- Idea 1\n- Idea 2\n- Idea 3",
};

export const Workspace = () => {
  const { basePath } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();

  useEffect(() => {
    const store = getSingltonStore();
    store.setValue("setting.direction", "rtl");
    store.setRow("files", "/file/chapter.md", {
      content: "123",
    });
    //load files
  }, []);

  // Decode the base path from URL
  const currentDirectory = basePath ? decodeURIComponent(basePath) : undefined;

  const handleSettingsToggle = (open: boolean) => {
    if (open) {
      searchParams.set("settings", "true");
    } else {
      searchParams.delete("settings");
    }
    setSearchParams(searchParams);
  };

  const [activeSidebarItem, setActiveSidebarItem] = useState("files");
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(240);
  const [files] = useState<FileNode[]>(initialFiles);
  const [selectedFileId, setSelectedFileId] = useState<string | null>("1");
  const [tabs, setTabs] = useState<Tab[]>([
    { id: "1", name: "2026-01-17", isModified: false },
  ]);
  const [activeTabId, setActiveTabId] = useState<string | null>("1");
  const [fileContents, setFileContents] =
    useState<Record<string, string>>(initialContents);
  const [isSynced, setIsSynced] = useState(true);
  const [isResizing, setIsResizing] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
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

      // Calculate new width based on mouse position
      // Account for the icon sidebar width (48px)
      const iconSidebarWidth = 48;
      const newWidth = e.clientX - iconSidebarWidth;

      // Clamp between min and max
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

  const handleFileSelect = useCallback((file: FileNode) => {
    if (file.type === "file") {
      setSelectedFileId(file.id);
      setTabs((prev) => {
        const existingTab = prev.find((t) => t.id === file.id);
        if (existingTab) {
          return prev;
        }
        return [...prev, { id: file.id, name: file.name, isModified: false }];
      });
      setActiveTabId(file.id);
    }
  }, []);

  const handleTabSelect = useCallback((tabId: string) => {
    setActiveTabId(tabId);
    setSelectedFileId(tabId);
  }, []);

  const handleTabClose = useCallback(
    (tabId: string) => {
      setTabs((prev) => {
        const newTabs = prev.filter((t) => t.id !== tabId);
        if (activeTabId === tabId && newTabs.length > 0) {
          setActiveTabId(newTabs[newTabs.length - 1].id);
          setSelectedFileId(newTabs[newTabs.length - 1].id);
        } else if (newTabs.length === 0) {
          setActiveTabId(null);
          setSelectedFileId(null);
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
      name: "Untitled",
      isModified: true,
    };
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(newId);
    setFileContents((prev) => ({ ...prev, [newId]: "" }));
  }, []);

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
        onSettingsClick={() => setIsSettingsOpen(true)}
        onCommandPaletteClick={() => setIsCommandPaletteOpen(true)}
      />

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Top Bar with File Controls and Tab Bar */}
        <div className="flex items-stretch border-b border-border shrink-0">
          {/* File Controls - synced width with file tree */}
          <div
            className="shrink-0 border-r border-border"
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
                className="shrink-0 bg-sidebar overflow-hidden"
                style={{ width: sidebarWidth }}
              >
                <FileTree
                  files={files}
                  selectedFileId={selectedFileId}
                  onFileSelect={handleFileSelect}
                  direction={direction}
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
                <p className="text-center">
                  No file selected. Open a file from the sidebar or create a new
                  one.
                </p>
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
      <SettingsModal
        open={isSettingsOpen}
        onOpenChange={setIsSettingsOpen}
        direction={direction}
        onDirectionChange={setDirection}
      />

      {/* Command Palette */}
      <CommandPalette
        open={isCommandPaletteOpen}
        onOpenChange={setIsCommandPaletteOpen}
        onNewFile={handleNewFile}
        onOpenSettings={() => {
          setIsCommandPaletteOpen(false);
          setIsSettingsOpen(true);
        }}
        onToggleSidebar={() => setIsSidebarCollapsed(!isSidebarCollapsed)}
        direction={direction}
      />
    </div>
  );
};
