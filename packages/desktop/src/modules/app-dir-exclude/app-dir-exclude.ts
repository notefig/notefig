/**
 * Keeps the app dir (`.notefig/`) out of the user's own git: once a
 * workspace is a git repo, its gitdir-local `info/exclude` (never the
 * tracked `.gitignore`) lists `.notefig/`, scratchpads included; they are
 * the app's, not the project's.
 *
 * Refreshed after each completed agent turn, so a repo the user inits
 * later gets the exclude on the next turn.
 */
import { defineModule } from "@notefig/core";
import type { FileSystemSurface } from "@/adapters/platform-adapter.interface";
import { platformModule } from "@/core/services";
import { APP_DIR_NAME } from "@/utils/app-dir";
import { ensureExcludeLines, type ExcludeFs } from "@/utils/git-exclude";
import { path as pathutil } from "@/utils/path";

/** What writing the exclude touches. */
export type AppDirExcludeFs = ExcludeFs & Pick<FileSystemSurface, "exists">;

/** Add `.notefig/` to the workspace repo's exclude, if the workspace is a
 *  repo. Best-effort: a failure is logged, never thrown. */
export async function excludeAppDir(
  fs: AppDirExcludeFs,
  workspacePath: string,
): Promise<void> {
  try {
    const userGitDir = pathutil.join(pathutil.normalize(workspacePath), ".git");
    const [userGit] = await fs.exists([userGitDir]);
    if (userGit?.exists && userGit.type === "directory") {
      await ensureExcludeLines(fs, userGitDir, [`${APP_DIR_NAME}/`]);
    }
  } catch (error) {
    console.warn(
      `Failed to update the user repo's exclude for '${workspacePath}':`,
      error,
    );
  }
}

declare module "@notefig/core" {
  interface CoreModules {
    "app-dir-exclude": undefined;
  }
}

export const appDirExcludeModule = defineModule({
  name: "app-dir-exclude",
  needs: [platformModule],
  boot: (_api, ctx) => {
    const { fs } = ctx.use("platform");
    return ctx.hooks.on("agent:turn-completed", ({ workspacePath }) => {
      void excludeAppDir(fs, workspacePath);
    });
  },
});
