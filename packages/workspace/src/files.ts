/**
 * FileHandle — identity + reads over a workspace file, plus the reverse
 * links (`.editor()`, `.tabs()`, `.blobs()`, `.git()`). Desktop owns the
 * actual file content (TanStack DB collections in `collections.ts`); this
 * module only knows the small `FileSnapshot` shape below, registered once
 * via `registerFileProvider`.
 */
import { createProvider } from "./provider";
import { createHandle } from "./handle";
import { editor, type EditorHandle } from "./editors";
import { blobsForFile, type BlobHandle } from "./blobs";
import { tabsForFile, type TabHandle } from "./tabs";
import { gitStatus, type GitStatusHandle } from "./git-status";

export interface FileSnapshot {
  content: string;
  exists: boolean;
}

export type FileProvider = (
  workspacePath: string,
  filePath: string,
) => FileSnapshot | undefined;

const fileProvider = createProvider<[string, string], FileSnapshot | undefined>(
  () => undefined,
);

export const registerFileProvider: (next: FileProvider) => void = fileProvider.register;

export interface FileHandle {
  readonly workspacePath: string;
  readonly filePath: string;
  content(): string | undefined;
  exists(): boolean;
  editor(): EditorHandle;
  blobs(): BlobHandle[];
  tabs(): TabHandle[];
  git(): GitStatusHandle;
}

export function file(workspacePath: string, filePath: string): FileHandle {
  return createHandle(
    { workspacePath, filePath },
    {
      content: (self) => fileProvider.resolve(self.workspacePath, self.filePath)?.content,
      exists: (self) => fileProvider.resolve(self.workspacePath, self.filePath)?.exists ?? false,
      editor: (self) => editor(self.workspacePath, self.filePath),
      blobs: (self) => blobsForFile(self.workspacePath, self.filePath),
      tabs: (self) => tabsForFile(self.workspacePath, self.filePath),
      git: (self) => gitStatus(self.workspacePath, self.filePath),
    },
  );
}
