/**
 * Keeps the app dir (`.notefig/`) out of the user's own git, bar the
 * project's config: once a workspace is a git repo, its gitdir-local
 * `info/exclude` (never the tracked `.gitignore`) holds the `notefig`
 * block. Scratchpads and the rest are the app's, not the project's; the
 * config is the project's and is committed.
 *
 * The block hides `.notefig/` whole (`APP_DIR_EXCLUDE_LINES`) unless the
 * config exists and the dir is not a repo of its own, and only then opens
 * it for the config (`USER_REPO_EXCLUDE_LINES`): git lists a dir the
 * re-include leaves open even with nothing in it to track, and commits an
 * older build's history repo there as an empty gitlink.
 *
 * Refreshed when a workspace opens, when its config changes, and after
 * each completed agent turn, so a repo the user inits later gets the
 * exclude on the next one.
 */
import { defineModule } from "@notefig/core";
import type { FileSystemSurface } from "@/adapters/platform-adapter.interface";
import { platformModule } from "@/core/services";
import {
  APP_DIR_EXCLUDE_LINES,
  APP_DIR_NAME,
  PROJECT_CONFIG_REL_PATH,
  USER_REPO_EXCLUDE_LINES,
} from "@/utils/app-dir";
import { setExcludeBlock, type ExcludeFs } from "@/utils/git-exclude";
import { path as pathutil } from "@/utils/path";

/** What writing the exclude touches. */
export type AppDirExcludeFs = ExcludeFs & Pick<FileSystemSurface, "exists">;

/** The `notefig` block's lines for this workspace as it is on disk. */
export async function appDirExcludeLines(
  fs: Pick<FileSystemSurface, "exists">,
  workspacePath: string,
): Promise<string[]> {
  const root = pathutil.normalize(workspacePath);
  const [config, nestedGit] = await fs.exists([
    pathutil.join(root, PROJECT_CONFIG_REL_PATH),
    pathutil.join(root, APP_DIR_NAME, ".git"),
  ]);
  return config?.exists && !nestedGit?.exists ? USER_REPO_EXCLUDE_LINES : APP_DIR_EXCLUDE_LINES;
}

/** Keep the app dir out of the workspace repo, if the workspace is a
 *  repo. Best-effort: a failure is logged, never thrown. */
export async function excludeAppDir(
  fs: AppDirExcludeFs,
  workspacePath: string,
): Promise<void> {
  try {
    const userGitDir = pathutil.join(pathutil.normalize(workspacePath), ".git");
    const [userGit] = await fs.exists([userGitDir]);
    if (userGit?.exists && userGit.type === "directory") {
      // `.notefig/` outside the block, as older builds wrote it, would
      // hide the config whatever the block says.
      await setExcludeBlock(fs, userGitDir, "notefig", await appDirExcludeLines(fs, workspacePath), [
        `${APP_DIR_NAME}/`,
      ]);
    }
  } catch (error) {
    console.warn(
      `Failed to update the user repo's exclude for '${workspacePath}':`,
      error,
    );
  }
}

/** Every write the app makes to a user repo's `info/exclude`, one at a
 *  time: each is a read-modify-write of the whole file, and two that
 *  interleave would drop one's block. */
export interface GitExcludes {
  /** Bring the `notefig` block up to date. Best-effort, never throws. */
  refresh(workspacePath: string): Promise<void>;
  /** `setExcludeBlock`, in turn with every other write. Throws. */
  setBlock(gitDir: string, name: string, lines: string[], retired?: string[]): Promise<void>;
}

export function createGitExcludes(fs: AppDirExcludeFs): GitExcludes {
  let queue: Promise<unknown> = Promise.resolve();
  const inTurn = <T>(write: () => Promise<T>): Promise<T> => {
    const run = queue.then(write);
    queue = run.catch(() => undefined);
    return run;
  };
  return {
    refresh: (workspacePath) => inTurn(() => excludeAppDir(fs, workspacePath)),
    setBlock: (gitDir, name, lines, retired) => inTurn(() => setExcludeBlock(fs, gitDir, name, lines, retired)),
  };
}

declare module "@notefig/core" {
  interface CoreModules {
    "app-dir-exclude": GitExcludes;
  }
}

export const appDirExcludeModule = defineModule({
  name: "app-dir-exclude",
  needs: [platformModule],
  register: (ctx) => createGitExcludes(ctx.use("platform").fs),
  boot: (excludes, ctx) => {
    const refresh = (workspacePath: string) => void excludes.refresh(workspacePath);
    const offs = [
      ctx.hooks.on("workspace:opened", ({ path }) => refresh(path)),
      ctx.hooks.on("project-settings:changed", ({ workspacePath }) => refresh(workspacePath)),
      ctx.hooks.on("agent:turn-completed", ({ workspacePath }) => refresh(workspacePath)),
    ];
    return () => {
      for (const off of offs) off();
    };
  },
});
