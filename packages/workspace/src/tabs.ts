/**
 * TabHandle — the central relational entity: identity + reads over one
 * dockable tab, plus `.editor()`, `.file()`, `.blobs()` links out. Dockable
 * layout lives in URL state, not a registry (see registry.ts's comment), so
 * this reads through an injected `TabSource` rather than a `Map` lookup.
 *
 * File tab ids are the file path, by convention (tab-id.ts); agent chat
 * tabs (`agent:<taskId>`) short-circuit every link to undefined/[] since
 * they aren't backed by a file at all.
 */
import { createProvider } from "./provider";
import { createHandle } from "./handle";
import { isAgentTabId } from "./tab-id";
import { editor, type EditorHandle } from "./editors";
import { file, type FileHandle } from "./files";
import { blobsForFile, type BlobHandle } from "./blobs";

export type TabSource = (workspacePath: string) => string[];

const tabSourceProvider = createProvider<[string], string[]>(() => []);

export const registerTabSource: (next: TabSource) => void = tabSourceProvider.register;

export interface TabHandle {
  readonly workspacePath: string;
  readonly tabId: string;
  isOpen(): boolean;
  isAgentTab(): boolean;
  editor(): EditorHandle | undefined;
  file(): FileHandle | undefined;
  blobs(): BlobHandle[];
}

export function tab(workspacePath: string, tabId: string): TabHandle {
  return createHandle(
    { workspacePath, tabId },
    {
      isOpen: (self) => tabSourceProvider.resolve(self.workspacePath).includes(self.tabId),
      isAgentTab: (self) => isAgentTabId(self.tabId),
      editor: (self) => (isAgentTabId(self.tabId) ? undefined : editor(self.workspacePath, self.tabId)),
      file: (self) => (isAgentTabId(self.tabId) ? undefined : file(self.workspacePath, self.tabId)),
      blobs: (self) => (isAgentTabId(self.tabId) ? [] : blobsForFile(self.workspacePath, self.tabId)),
    },
  );
}

/** Open tabs whose id resolves to this file path — backs `FileHandle.tabs()`. */
export function tabsForFile(workspacePath: string, filePath: string): TabHandle[] {
  return tabSourceProvider
    .resolve(workspacePath)
    .filter((id) => id === filePath)
    .map((id) => tab(workspacePath, id));
}
