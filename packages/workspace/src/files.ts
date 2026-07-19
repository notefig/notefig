/**
 * FileHandle — identity + reads over a workspace file, plus the reverse
 * links (`.tabs()`, `.blobs()`, `.git()`). Desktop owns the actual file
 * content (TanStack DB collections in `collections.ts`); this module only
 * knows the small `FileSnapshot` shape below, registered once via
 * `registerFileProvider`.
 */
import { createProvider } from "./provider";
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
  blobs(): BlobHandle[];
  tabs(): TabHandle[];
  git(): GitStatusHandle;
}

export function file(workspacePath: string, filePath: string): FileHandle {
  return {
    workspacePath,
    filePath,
    content() {
      return fileProvider.resolve(workspacePath, filePath)?.content;
    },
    exists() {
      return fileProvider.resolve(workspacePath, filePath)?.exists ?? false;
    },
    blobs() {
      return blobsForFile(workspacePath, filePath);
    },
    tabs() {
      return tabsForFile(workspacePath, filePath);
    },
    git() {
      return gitStatus(workspacePath, filePath);
    },
  };
}
