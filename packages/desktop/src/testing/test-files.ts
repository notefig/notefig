/**
 * Workspace files for tests: an instance built from an fs the test hands
 * in, and a `files` module that serves instances a test already built — so
 * a component reading `useWorkspaceModule(ws, "files")` sees them through
 * an ordinary core. No module mocks of the platform.
 */
import { QueryClient } from "@tanstack/react-query";
import { defineModule, type AnyModule } from "@notefig/core";
import type { FileSystemSurface } from "@/adapters/platform-adapter.interface";
import { createWorkspaceFiles, type WorkspaceFiles } from "@/entities/files";
import { workspaceKey } from "@/utils/path";

/** An fs whose watching does nothing; give the reads and writes a test
 *  exercises. */
export function testFs(fs: Partial<FileSystemSurface>): FileSystemSurface {
  return {
    onFsEvent: () => () => {},
    startWatchingMetadata: async () => {},
    startWatchingContent: async () => {},
    stopWatching: async () => {},
    ...fs,
  } as FileSystemSurface;
}

export function testWorkspaceFiles(
  workspacePath: string,
  fs: Partial<FileSystemSurface>,
): WorkspaceFiles {
  return createWorkspaceFiles({
    workspacePath,
    fs: testFs(fs),
    queryClient: new QueryClient(),
  });
}

/** A `files` module whose instance for each workspace is the one given. */
export function filesModuleOf(instances: WorkspaceFiles[]): AnyModule {
  const byKey = new Map(
    instances.map((files) => [workspaceKey(files.workspacePath), files]),
  );
  return defineModule({
    name: "files",
    workspace: {
      create: ({ workspace }) => {
        const files = byKey.get(workspace.key);
        if (!files) throw new Error(`no test files for ${workspace.path}`);
        return files;
      },
    },
  });
}
