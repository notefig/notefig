import { useAtom } from "jotai";
import {
  fileSystemAtom,
  activeFileContentAtom,
  createFileState,
} from "@/atoms/fileSystem";
import { fs, normalizePath } from "@/utils/fs";
import { useTabNavigation } from "@/hooks/useTabNavigation";
import { useEffect } from "react";
import { calculateContentHash } from "@/utils/hash";

export interface UseFileManagerOptions {
  onError?: (error: string) => void;
  onSave?: (filePath: string) => void;
}

export function useFileManager(options: UseFileManagerOptions = {}) {
  const [fileSystem, setFileSystem] = useAtom(fileSystemAtom);
  const [, setActiveFileContent] = useAtom(activeFileContentAtom);
  const tabNavigation = useTabNavigation();

  const loadFile = async (path: string) => {
    const normalizedPath = normalizePath(path);
    // Set loading state
    setFileSystem((prev) => ({
      ...prev,
      files: {
        ...prev.files,
        [normalizedPath]: {
          ...createFileState("", "loading"),
          ...prev.files[normalizedPath], // Preserve existing data if any
          state: "loading",
        },
      },
    }));

    try {
      const content = await fs.readTextFile(path);
      const fileState = createFileState(content, "loaded");
      setFileSystem((prev) => ({
        ...prev,
        files: {
          ...prev.files,
          [normalizedPath]: {
            ...fileState,
            lastModified: new Date(),
          },
        },
      }));
    } catch (error) {
      const errorMessage = `Failed to load file: ${error}`;
      const errorFileState = createFileState("", "error");
      setFileSystem((prev) => ({
        ...prev,
        files: {
          ...prev.files,
          [normalizedPath]: {
            ...errorFileState,
            error: errorMessage,
          },
        },
      }));
      options.onError?.(errorMessage);
    }
  };

  const saveFile = async (path: string, content?: string) => {
    const normalizedPath = normalizePath(path);
    const targetContent = content || fileSystem.files[normalizedPath]?.content;

    if (!path || targetContent === undefined) {
      options.onError?.("No file path or content specified for save");
      return false;
    }

    // Set saving state
    setFileSystem((prev) => ({
      ...prev,
      files: {
        ...prev.files,
        [normalizedPath]: {
          ...prev.files[normalizedPath],
          state: "saving",
        },
      },
    }));

    try {
      await fs.writeTextFile(path, targetContent);
      // Update with new hash after successful save
      const newHash = calculateContentHash(targetContent);
      setFileSystem((prev) => ({
        ...prev,
        files: {
          ...prev.files,
          [normalizedPath]: {
            content: targetContent,
            originalContent: targetContent,
            savedContentHash: newHash,
            state: "loaded",
            lastModified: new Date(),
          },
        },
      }));
      options.onSave?.(normalizedPath);
      return true;
    } catch (error) {
      const errorMessage = `Failed to save file: ${error}`;
      setFileSystem((prev) => ({
        ...prev,
        files: {
          ...prev.files,
          [normalizedPath]: {
            ...prev.files[normalizedPath],
            state: "error",
            error: errorMessage,
          },
        },
      }));
      options.onError?.(errorMessage);
      return false;
    }
  };

  const saveActiveFile = () => {
    if (fileSystem.activeTabPath) {
      return saveFile(fileSystem.activeTabPath);
    }
    return Promise.resolve(false);
  };

  const reloadFile = (path: string) => {
    return loadFile(path);
  };

  const discardChanges = (path: string) => {
    const normalizedPath = normalizePath(path);
    if (fileSystem.files[normalizedPath]) {
      const file = fileSystem.files[normalizedPath];
      setFileSystem((prev) => ({
        ...prev,
        files: {
          ...prev.files,
          [normalizedPath]: {
            ...file,
            content: file.originalContent,
            state: "loaded",
          },
        },
      }));
    }
  };

  // Sync file system state with URL-based tab navigation
  const currentActiveTabPath =
    tabNavigation.tabs.length > 0 && tabNavigation.activeIndex >= 0
      ? tabNavigation.getAbsolutePath(
          tabNavigation.tabs[tabNavigation.activeIndex],
        )
      : null;

  useEffect(() => {
    // Update file system state to match URL state
    setFileSystem((prev) => ({
      ...prev,
      activeTabPath: currentActiveTabPath,
    }));
  }, [currentActiveTabPath, setFileSystem]);

  // Load active file when it changes and isn't already loaded
  useEffect(() => {
    if (currentActiveTabPath && !fileSystem.files[currentActiveTabPath]) {
      loadFile(currentActiveTabPath);
    }
  }, [currentActiveTabPath, fileSystem.files]);

  // Tab operations (now delegate to URL navigation)
  const openTab = async (path: string) => {
    // Use URL navigation to manage tab state
    tabNavigation.openTab(path);

    // Load the file if it's not already loaded
    if (!fileSystem.files[path]) {
      await loadFile(path);
    }
  };

  const closeTab = (path: string) => {
    tabNavigation.closeTab(path);
  };

  const switchTab = (path: string) => {
    tabNavigation.switchToTabByPath(path);
  };

  const switchToTabIndex = (index: number) => {
    tabNavigation.switchToTab(index);
  };

  const closeAllTabs = () => {
    tabNavigation.closeAllTabs();
  };

  const activeFile = currentActiveTabPath
    ? fileSystem.files[currentActiveTabPath]
    : null;

  // Create tab objects for compatibility
  const tabs = tabNavigation.tabs.map((relativePath, index) => ({
    index,
    filePath: tabNavigation.getAbsolutePath(relativePath) || "",
    relativePath,
  }));

  return {
    // Active tab state
    activeFile,
    activeFilePath: currentActiveTabPath,
    isActiveFileLoading: activeFile?.state === "loading",
    isActiveFileSaving: activeFile?.state === "saving",
    isActiveFileModified: activeFile?.state === "loaded_modified",
    hasActiveFileError: activeFile?.state === "error",

    // Tab operations
    openTab,
    closeTab,
    switchTab,
    switchToTabIndex,
    closeAllTabs,

    // Tab state (URL-driven)
    tabs,
    activeTabIndex: tabNavigation.activeIndex,
    hasOpenTabs: tabNavigation.tabs.length > 0,

    // Tab navigation state
    tabNavigation,

    // File operations
    loadFile,
    saveFile,
    saveActiveFile,
    reloadFile,
    discardChanges,

    // Content management
    setActiveFile: setActiveFileContent,

    // File system state
    allFiles: fileSystem.files,
    fileSystem,
  };
}
