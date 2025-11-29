import { atom } from "jotai";

export interface FileState {
  content: string;
  originalContent: string; // Track original for modification detection
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
      const isModified = newContent !== activeFile.originalContent;

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

// Helper atom to get all modified files
export const modifiedFilesAtom = atom((get) => {
  const fs = get(fileSystemAtom);
  return Object.entries(fs.files)
    .filter(([, file]) => file.state === "loaded_modified")
    .map(([path]) => path);
});
