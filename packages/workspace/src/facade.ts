/**
 * Main entry point — mirrors desktop's `agents.workspace(path)` shape.
 * Flat constructors (`tab()`, `file()`, ...) stay exported directly from
 * their own modules for callers that don't want the facade object.
 *
 * Relationship-method convention, followed by every handle in this package:
 * a link to one related entity is a zero-arg method named after the target
 * type (`.file()`, `.tab()`, `.editor()`), a link to many is the plural
 * (`.blobs()`, `.tabs()`). Every link is computed fresh from the relevant
 * provider on each call — nothing here is a cached edge, so the graph is
 * always consistent with current provider state, never a stale snapshot of
 * it. See `provider.ts` for why that's also the deliberate GC boundary.
 */
import { tab, type TabHandle } from "./tabs";
import { editor, type EditorHandle } from "./editors";
import { file, type FileHandle } from "./files";
import { blob, type BlobHandle } from "./blobs";
import { gitStatus, type GitStatusHandle } from "./git-status";

export interface WorkspaceHandle {
  readonly workspacePath: string;
  tab(tabId: string): TabHandle;
  editor(filePath: string): EditorHandle;
  file(filePath: string): FileHandle;
  blob(filePath: string, blobId: string): BlobHandle;
  git(filePath: string): GitStatusHandle;
}

export function workspace(workspacePath: string): WorkspaceHandle {
  return {
    workspacePath,
    tab: (tabId) => tab(workspacePath, tabId),
    editor: (filePath) => editor(workspacePath, filePath),
    file: (filePath) => file(workspacePath, filePath),
    blob: (filePath, blobId) => blob(workspacePath, filePath, blobId),
    git: (filePath) => gitStatus(workspacePath, filePath),
  };
}
