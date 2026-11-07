/**
 * Worktree writes, captured instead of written. A pull in the sync worker
 * runs `rebaseOnto`, which moves the branch and the index and then rewrites
 * each changed worktree file that still holds its old committed bytes.
 * Those writes must not go straight to disk from the worker: the main
 * thread applies them through the documents write path, so open editors
 * adopt the content (keeping the caret), rows follow, and a document with
 * unsaved edits is held instead of overwritten. While a capture runs, the
 * wrapped host records worktree writes and deletes (files under the
 * workspace, outside `.git`) and lets everything inside `.git` through.
 */
import type { GitRepoRef, GitStorageHost } from "@notefig/git";
import type { SyncWrite } from "../sync-types";

export interface WorktreeCapture {
  /** The host git uses for `repo`, with capture built in. */
  wrap(host: GitStorageHost, repo: GitRepoRef): GitStorageHost;
  /** Run `op` with `repo`'s worktree writes captured. */
  run<T>(
    repo: GitRepoRef,
    op: () => Promise<T>,
  ): Promise<{ result: T; writes: SyncWrite[] }>;
}

const slashes = (path: string) => path.replace(/\\/g, "/").replace(/\/+$/, "");

/** A file's bytes as the main thread writes them: text when it decodes as
 *  UTF-8 with no NUL, binary otherwise. */
export function toSyncWrite(path: string, bytes: Uint8Array | null): SyncWrite {
  if (bytes === null) return { path, kind: "delete" };
  if (!bytes.includes(0)) {
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      return { path, kind: "text", text };
    } catch {
      // not text
    }
  }
  return { path, kind: "binary", bytes };
}

export function createWorktreeCapture(): WorktreeCapture {
  /** repo path → captured writes, while a capture runs. */
  const active = new Map<string, Map<string, Uint8Array | null>>();

  return {
    wrap(host, repo) {
      const root = `${slashes(repo.repoPath)}/`;
      const gitDir = `${slashes(repo.gitDir)}/`;
      /** The worktree-relative path when `path` is a worktree file and a
       *  capture is running; null otherwise. */
      const captured = (path: string) => {
        const writes = active.get(repo.repoPath);
        const normalized = slashes(path);
        if (!writes || !normalized.startsWith(root)) return null;
        if (`${normalized}/`.startsWith(gitDir)) return null;
        return { writes, relative: normalized.slice(root.length) };
      };
      return {
        ...host,
        writeFileAtomic: async (path, data) => {
          const target = captured(path);
          if (target) target.writes.set(target.relative, data);
          else await host.writeFileAtomic(path, data);
        },
        deleteFile: async (path) => {
          const target = captured(path);
          if (target) target.writes.set(target.relative, null);
          else await host.deleteFile(path);
        },
        // The main thread's writes create parent folders themselves.
        createDir: async (path) => {
          if (!captured(path)) await host.createDir(path);
        },
      };
    },
    async run(repo, op) {
      const writes = new Map<string, Uint8Array | null>();
      active.set(repo.repoPath, writes);
      try {
        const result = await op();
        return {
          result,
          writes: [...writes].map(([path, bytes]) => toSyncWrite(path, bytes)),
        };
      } finally {
        active.delete(repo.repoPath);
      }
    },
  };
}
