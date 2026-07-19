/**
 * The complete, explicit boundary between desktop and `@metrists/workspace`:
 * every provider desktop hands to the workspace package's entity-handle
 * graph (TabHandle/EditorHandle/FileHandle/BlobHandle/GitStatusHandle) is
 * registered here, in one place, instead of as scattered side effects
 * across the modules that own the underlying state. Each `read*` function
 * still lives next to the state it reads (private-map access requires
 * that); this file only wires them in. Call `installWorkspaceProviders()`
 * once, before any code that constructs a workspace handle runs (main.tsx).
 */
import {
  registerEditorProvider,
  registerFileProvider,
  registerGitStatusProvider,
  registerTabSource,
  registerAuthorTaskLookup,
} from "@metrists/workspace";
import { readEditorSnapshot, readOpenTabIds } from "@/components/editor/editor-store";
import { readFileSnapshot } from "@/utils/collections";
import { readRepoStatus } from "@/utils/git-service-store";
import { findBlobAuthorTask } from "@/agent/agent-service";

let installed = false;

export function installWorkspaceProviders(): void {
  if (installed) return;
  installed = true;

  registerEditorProvider(readEditorSnapshot);
  registerTabSource(readOpenTabIds);
  registerFileProvider(readFileSnapshot);
  registerGitStatusProvider(readRepoStatus);
  registerAuthorTaskLookup(findBlobAuthorTask);
}
