/**
 * GitStatusHandle — a path-scoped view over the whole-repo `RepoStatus`
 * desktop already fetches (via `@metrists/git`'s `IsomorphicGitService`).
 * No new git computation happens here: this just derives one file's state
 * from data that's already been queried, so it's as cheap as the existing
 * workspace-level status query.
 */
import type { RepoStatus, GitFileChange } from "@metrists/git";
import { createProvider } from "./provider";
import { createHandle } from "./handle";

export type FileGitState =
  | { kind: "clean" }
  | { kind: "untracked" }
  | { kind: "staged"; changeType: GitFileChange["type"] }
  | { kind: "unstaged"; changeType: GitFileChange["type"] }
  | {
      kind: "staged+unstaged";
      stagedType: GitFileChange["type"];
      unstagedType: GitFileChange["type"];
    }
  | { kind: "conflict" };

/** Cached/query-backed whole-repo status; may be stale by design (mirrors
 *  the existing status-bar's cached query) or undefined if not fetched yet. */
export type GitStatusProvider = (workspacePath: string) => RepoStatus | undefined;

const gitStatusProvider = createProvider<[string], RepoStatus | undefined>(() => undefined);

export const registerGitStatusProvider: (next: GitStatusProvider) => void =
  gitStatusProvider.register;

export interface GitStatusHandle {
  readonly workspacePath: string;
  readonly filePath: string;
  /** undefined only if no repo status has been fetched for this workspace yet. */
  state(): FileGitState | undefined;
}

function relativize(workspacePath: string, filePath: string): string {
  if (!filePath.startsWith(workspacePath)) return filePath;
  return filePath.slice(workspacePath.length).replace(/^[/\\]/, "");
}

function deriveState(status: RepoStatus, relativePath: string): FileGitState {
  if (status.conflicts.includes(relativePath)) return { kind: "conflict" };

  const staged = status.staged.find(
    (change) => change.path === relativePath || change.oldPath === relativePath,
  );
  const unstaged = status.unstaged.find(
    (change) => change.path === relativePath || change.oldPath === relativePath,
  );

  if (staged && unstaged) {
    return { kind: "staged+unstaged", stagedType: staged.type, unstagedType: unstaged.type };
  }
  if (staged) return { kind: "staged", changeType: staged.type };
  if (unstaged) return { kind: "unstaged", changeType: unstaged.type };
  if (status.untracked.includes(relativePath)) return { kind: "untracked" };
  return { kind: "clean" };
}

export function gitStatus(workspacePath: string, filePath: string): GitStatusHandle {
  return createHandle(
    { workspacePath, filePath },
    {
      state: (self) => {
        const status = gitStatusProvider.resolve(self.workspacePath);
        if (!status) return undefined;
        return deriveState(status, relativize(self.workspacePath, self.filePath));
      },
    },
  );
}
