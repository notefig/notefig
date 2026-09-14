/**
 * The desktop's ACP file-system bridge.
 *
 * The path rules a harness feels — relative-path resolution, `../` escapes,
 * containment in the workspace, the 1-based line/limit window — are protocol
 * decisions, not platform ones, so they come from core's
 * `createAcpFileSystem` and are identical on both hosts. Before this, the
 * desktop passed `readWorkspaceTextFile`/`writeWorkspaceTextFile` straight to
 * the ACP client: relative paths threw instead of resolving, and
 * **containment was never checked at all** — `assertAbsoluteWorkspacePath`
 * tests `isAbsolute` and nothing more, so an absolute path outside the
 * workspace was written.
 *
 * It lives in the agent cluster, not in `utils/file-sync`, because it is
 * protocol wiring: the dependency runs agent → file-sync, which is the
 * direction MET-193 just finished restoring when it broke the
 * components → agent-service → acp-client → file-sync cycle. file-sync owns
 * the write primitive and knows nothing about ACP.
 */
import { createAcpFileSystem } from "@notefig/core";
import { platformAdapter } from "@/adapters";
import { path as pathutil } from "@/utils/path";
import { writeWorkspaceTextFile } from "@/utils/file-sync";

/**
 * What stays desktop-shaped is the bytes underneath, and that is the whole
 * reason this wraps a `CoreFileSystem` rather than passing
 * `platformAdapter.fs` straight through: the write has to go through
 * `writeWorkspaceTextFile` to keep the rename redirect, the tracked-write
 * echo suppression, the row update, and the editor adoption. Reads go raw,
 * because the windowing `readWorkspaceTextFile` applies is the bridge's job
 * here — applying it in both places would slice twice.
 */
export function createDesktopAcpFileSystem(workspacePath: string) {
  return createAcpFileSystem(
    {
      ...platformAdapter.fs,
      writeFiles: async (files) => {
        // The bridge writes one resolved file at a time; a throw from the
        // desktop primitive is already an FsError and propagates as the
        // bridge's own failures would.
        for (const file of files) {
          await writeWorkspaceTextFile(file.path, file.content);
        }
        return { succeeded: files.map((file) => file.path), failed: [] };
      },
    },
    { workspacePath, path: pathutil },
  );
}
