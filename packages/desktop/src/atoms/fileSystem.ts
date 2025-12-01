import { atom } from "jotai";
import { calculateContentHash, isContentModified } from "@/utils/hash";

export interface FileState {
  content: string;
  originalContent: string; // Track original for modification detection
  savedContentHash: string; // Hash of the saved content on disk
  state: "loading" | "loaded" | "loaded_modified" | "error" | "saving";
  lastModified?: Date;
  error?: string;
}

export interface FileSystemState {
  files: Record<string, FileState>;
  activeTabPath: string | null; // Synced from URL state
}

export const fileSystemAtom = atom<FileSystemState>({
  files: {},
  activeTabPath: null,
});

export const activeFileAtom = atom((get) => {
  const fs = get(fileSystemAtom);
  return fs.activeTabPath ? fs.files[fs.activeTabPath] : null;
});

export const activeFileContentAtom = atom(
  (get) => get(activeFileAtom)?.content ?? "",
  (get, set, newContent: string) => {
    const fs = get(fileSystemAtom);
    if (fs.activeTabPath && fs.files[fs.activeTabPath]) {
      const activeFile = fs.files[fs.activeTabPath];
      const isModified = isContentModified(
        newContent,
        activeFile.savedContentHash,
      );

      set(fileSystemAtom, {
        ...fs,
        files: {
          ...fs.files,
          [fs.activeTabPath]: {
            ...activeFile,
            content: newContent,
            state: isModified ? "loaded_modified" : "loaded",
          },
        },
      });
    }
  },
);

export const hasUnsavedChangesAtom = atom((get) => {
  const fs = get(fileSystemAtom);
  return Object.values(fs.files).some(
    (file) => file.state === "loaded_modified",
  );
});

// Helper atom to get all modified files (using hash comparison)
export const modifiedFilesAtom = atom((get) => {
  const fs = get(fileSystemAtom);
  return Object.entries(fs.files)
    .filter(([, file]) => isFileModified(file))
    .map(([path]) => path);
});

// Helper function to check if a file is modified using hash comparison
export function isFileModified(file: FileState): boolean {
  return isContentModified(file.content, file.savedContentHash);
}

// Derived atom that checks modification status using hash (more accurate than state)
export const hasUnsavedChangesHashAtom = atom((get) => {
  const fs = get(fileSystemAtom);
  return Object.values(fs.files).some(isFileModified);
});

// Helper function to create initial file state with hash
export function createFileState(
  content: string,
  state: FileState["state"] = "loaded",
): Omit<FileState, "lastModified" | "error"> {
  const hash = calculateContentHash(content);
  return {
    content,
    originalContent: content,
    savedContentHash: hash,
    state,
  };
}
