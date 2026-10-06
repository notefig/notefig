/**
 * The per-workspace document-history git repo — a second, app-owned git
 * repo layered over the same worktree as the user's files, gitdir at
 * `<workspace>/.notefig/.git`, never interfering with a workspace that's
 * already its own git repo: `.notefig/` (the app's ephemeral-files root) is
 * hidden from the user's repo via its `.git/info/exclude`.
 *
 * Each open workspace's repo is the history module's workspace instance
 * (`core.workspace(ws).history`), built from what core hands it and freed
 * when the workspace closes. It also owns one policy: a checkpoint after
 * every completed agent turn in its workspace.
 */
import type { GitRepoRef, GitService } from "@notefig/git";
import { defineModule } from "@notefig/core";
import type { FileSystemSurface } from "@/adapters/platform-adapter.interface";
import type { GitWorker } from "@/utils/git-worker-client";
import { emitAppEvent, onAppEvent } from "@/utils/app-events";
import { path as pathutil, workspaceKey } from "@/utils/path";
import { ensureExcludeLines, type ExcludeFs } from "@/utils/git-exclude";
import { APP_DIR_NAME, SCRATCHPADS_REL_PATH } from "@/utils/app-dir";

export function historyGitDir(workspacePath: string): string {
  return pathutil.join(
    pathutil.normalize(workspacePath),
    APP_DIR_NAME,
    ".git",
  );
}

/**
 * Excludes for the history repo's own worktree walk: everything under the
 * app dir except the scratchpads folder, plus the user's `.git/`. Its
 * storage host walks with includeHidden and no ignore rules, so this file
 * is the only thing keeping the app's own gitdir and agent state out of
 * checkpoints — while scratchpads (entities/scratchpads.ts) must stay in.
 * The `dir/*` + `!dir/child` shape is the one git idiom that re-includes
 * inside an otherwise-excluded directory; excluding `.notefig/` wholesale
 * would make the negation unreachable.
 */
const HISTORY_EXCLUDE_LINES = [
  `${APP_DIR_NAME}/*`,
  `!${SCRATCHPADS_REL_PATH}`,
  ".git/",
];

/** What a workspace's history repo is built from. */
export interface HistoryDeps {
  workspacePath: string;
  fs: ExcludeFs & Pick<FileSystemSurface, "exists">;
  /** Where repos run: the git worker in the app. */
  git: GitWorker;
}

/** One workspace's history repo — `core.workspace(ws).history`. */
export interface WorkspaceHistory {
  /** The repo as it is: not created if it does not exist yet (its status
   *  then fails with RepoNotFound, which is how "uninitialized" reads). */
  service(): GitService;
  /** The repo, initialized on first use. */
  ready(): Promise<GitService>;
  /** A file's text at a checkpoint (`relativePath` from the root). */
  read(ref: string, relativePath: string): Promise<string>;
  /** Commit everything dirty; the new oid, or null if nothing changed. */
  checkpoint(
    message: string,
    author: { name: string; email: string },
  ): Promise<string | null>;
  /** Drop the repo's service and its worker state. The history is closed
   *  for good: later calls (and a `ready` still waiting) reject rather than
   *  recreate a service nothing would dispose. */
  dispose(): void;
}

export function createWorkspaceHistory({
  workspacePath,
  fs,
  git,
}: HistoryDeps): WorkspaceHistory {
  const gitDir = historyGitDir(workspacePath);
  let service: GitService | null = null;
  let initializing: Promise<void> | null = null;
  let disposed = false;

  // Worker-backed (with an inline fallback): statusMatrix's worktree
  // hashing and packfile parsing run off the main thread.
  const getService = () => {
    if (disposed) {
      throw new Error(`The history of '${workspacePath}' is closed`);
    }
    return (service ??= git.create({ repoPath: workspacePath, gitDir }));
  };

  const initialize = async () => {
    await getService().init({ defaultBranch: "main" });

    try {
      await ensureExcludeLines(fs, gitDir, HISTORY_EXCLUDE_LINES);
    } catch (error) {
      console.warn(
        `Failed to update the history repo's exclude for '${workspacePath}':`,
        error,
      );
    }

    // Hide the whole app dir from the user's own repo via its gitdir-local
    // exclude (never the tracked .gitignore) — scratchpads included; they
    // are the app's, not the project's. Runs on every ensure call — this
    // block re-executes per checkpoint, so a repo the user inits *after*
    // history exists gets the exclude on the next turn.
    try {
      const userGitDir = pathutil.join(workspacePath, ".git");
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
  };

  const ready = async () => {
    // Calls while one is running join it; a later call runs it again.
    initializing ??= initialize().finally(() => {
      initializing = null;
    });
    await initializing;
    return getService();
  };

  return {
    service: getService,
    ready,
    read: async (ref, relativePath) =>
      (await ready()).readTextFile({ ref, filepath: relativePath }),
    checkpoint: async (message, author) =>
      (await ready()).addAllAndCommit({ message, author }),
    dispose() {
      disposed = true;
      service = null;
      initializing = null;
      git.dispose(gitDir);
    },
  };
}

/** A checkpoint's message from the prompt that led to it. */
function checkpointMessage(prompt: string): string {
  return prompt.length > 72 ? `${prompt.slice(0, 69)}…` : prompt;
}

declare module "@notefig/core" {
  interface WorkspaceModules {
    history: WorkspaceHistory;
  }
}

/**
 * The history repo lives as long as its workspace is open: closing the
 * workspace drops the service and its git worker. Agents need it, so their
 * tasks are disposed first — cancelling a turn can still checkpoint here.
 */
export const historyModule = defineModule({
  name: "history",
  needs: ["platform", "gitWorker"],
  workspace: {
    create: (ctx) => {
      const history = createWorkspaceHistory({
        workspacePath: pathutil.normalize(ctx.workspace.path),
        fs: ctx.use("platform").fs,
        git: ctx.use("gitWorker"),
      });
      const instance: WorkspaceHistory = {
        ...history,
        dispose() {
          stopCheckpointing();
          history.dispose();
        },
      };
      // One checkpoint per completed agent turn here (Track D.3),
      // best-effort: history is a convenience, never a turn's failure.
      const stopCheckpointing = onAppEvent(
        "agent:turn-completed",
        ({ workspacePath, prompt, harnessId }) => {
          if (workspaceKey(workspacePath) !== ctx.workspace.key) return;
          void instance
            .checkpoint(checkpointMessage(prompt), {
              name: harnessId,
              email: "agent@notefig.local",
            })
            // The commit lands in the hidden gitdir, which no watcher sees.
            .then(() => emitAppEvent("git:stale", { workspacePath }))
            .catch((error: unknown) =>
              console.warn("[history] turn checkpoint failed:", error),
            );
        },
      );
      return instance;
    },
    dispose: (history) => history.dispose(),
  },
});
