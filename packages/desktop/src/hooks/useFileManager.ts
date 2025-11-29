import { useEffect } from "react";
import { useAtom } from "jotai";
import { fileSystemAtom, currentFileContentAtom } from "@/atoms/fileSystem";
import { readAbsoluteTextFile, writeAbsoluteTextFile } from "@/utils/fs";

export interface UseFileManagerOptions {
  autoLoad?: boolean;
  onError?: (error: string) => void;
  onSave?: (filePath: string) => void;
}

export function useFileManager(
  filePath: string | null | undefined,
  options: UseFileManagerOptions = {},
) {
  const [fileSystem, setFileSystem] = useAtom(fileSystemAtom);
  const [, setCurrentFileContent] = useAtom(currentFileContentAtom);

  // Auto-load file when path changes
  useEffect(() => {
    if (filePath && options.autoLoad !== false) {
      loadFile(filePath);
    }
  }, [filePath, options.autoLoad]);

  const loadFile = async (path: string) => {
    // Set loading state and make this the current file
    setFileSystem((prev) => ({
      ...prev,
      currentFile: path,
      files: {
        ...prev.files,
        [path]: {
          content: prev.files[path]?.content ?? "",
          originalContent: prev.files[path]?.originalContent ?? "",
          state: "loading",
        },
      },
    }));

    try {
      const content = await readAbsoluteTextFile(path);
      setFileSystem((prev) => ({
        ...prev,
        files: {
          ...prev.files,
          [path]: {
            content,
            originalContent: content,
            state: "loaded",
            lastModified: new Date(),
          },
        },
      }));
    } catch (error) {
      const errorMessage = `Failed to load file: ${error}`;
      setFileSystem((prev) => ({
        ...prev,
        files: {
          ...prev.files,
          [path]: {
            content: "",
            originalContent: "",
            state: "error",
            error: errorMessage,
          },
        },
      }));
      options.onError?.(errorMessage);
    }
  };

  const saveFile = async (path?: string, content?: string) => {
    const targetPath = path || filePath;
    const targetContent =
      content || fileSystem.files[targetPath || ""]?.content;

    if (!targetPath || targetContent === undefined) {
      options.onError?.("No file path or content specified for save");
      return false;
    }

    // Set saving state
    setFileSystem((prev) => ({
      ...prev,
      files: {
        ...prev.files,
        [targetPath]: {
          ...prev.files[targetPath],
          state: "saving",
        },
      },
    }));

    try {
      await writeAbsoluteTextFile(targetPath, targetContent);
      setFileSystem((prev) => ({
        ...prev,
        files: {
          ...prev.files,
          [targetPath]: {
            content: targetContent,
            originalContent: targetContent,
            state: "loaded",
            lastModified: new Date(),
          },
        },
      }));
      options.onSave?.(targetPath);
      return true;
    } catch (error) {
      const errorMessage = `Failed to save file: ${error}`;
      setFileSystem((prev) => ({
        ...prev,
        files: {
          ...prev.files,
          [targetPath]: {
            ...prev.files[targetPath],
            state: "error",
            error: errorMessage,
          },
        },
      }));
      options.onError?.(errorMessage);
      return false;
    }
  };

  const saveCurrentFile = () => {
    if (filePath) {
      return saveFile(filePath);
    }
    return Promise.resolve(false);
  };

  const reloadFile = (path?: string) => {
    const targetPath = path || filePath;
    if (targetPath) {
      return loadFile(targetPath);
    }
  };

  const discardChanges = (path?: string) => {
    const targetPath = path || filePath;
    if (targetPath && fileSystem.files[targetPath]) {
      const file = fileSystem.files[targetPath];
      setFileSystem((prev) => ({
        ...prev,
        files: {
          ...prev.files,
          [targetPath]: {
            ...file,
            content: file.originalContent,
            state: "loaded",
          },
        },
      }));
    }
  };

  const currentFile = filePath ? fileSystem.files[filePath] : null;

  return {
    // File state
    currentFile,
    isLoading: currentFile?.state === "loading",
    isSaving: currentFile?.state === "saving",
    isModified: currentFile?.state === "loaded_modified",
    hasError: currentFile?.state === "error",

    // File operations
    loadFile,
    saveFile,
    saveCurrentFile,
    reloadFile,
    discardChanges,

    // Content management
    setCurrentFile: setCurrentFileContent,

    // File system state
    allFiles: fileSystem.files,
    fileSystem,
  };
}
