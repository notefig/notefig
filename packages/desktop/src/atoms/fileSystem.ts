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
  currentFile: string | null;
}

export const fileSystemAtom = atom<FileSystemState>({
  files: {},
  currentFile: null,
});

// Derived atoms for easier access
export const currentFileAtom = atom((get) => {
  const fs = get(fileSystemAtom);
  return fs.currentFile ? fs.files[fs.currentFile] : null;
});

export const currentFileContentAtom = atom(
  (get) => get(currentFileAtom)?.content ?? "",
  (get, set, newContent: string) => {
    const fs = get(fileSystemAtom);
    if (fs.currentFile && fs.files[fs.currentFile]) {
      const currentFile = fs.files[fs.currentFile];
      const isModified = newContent !== currentFile.originalContent;

      set(fileSystemAtom, {
        ...fs,
        files: {
          ...fs.files,
          [fs.currentFile]: {
            ...currentFile,
            content: newContent,
            state: isModified ? "loaded_modified" : "loaded",
          },
        },
      });
    }
  },
);

// Helper atom to check if any files have unsaved changes
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
