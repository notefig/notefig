import type { GitStorageHost } from "@notefig/git";
import type {
  BatchResult,
  FileSystemSurface,
} from "./platform-adapter.interface";
import { path as pathutil } from "@/utils/path";

/**
 * Git's storage host, built purely on the fs surface.
 *
 * This used to be duplicated verbatim in `tauri-adapter.ts` and
 * `base-browser-adapter.ts` — the two copies were byte-identical, including
 * the three "unsupported" throws, because nothing here is platform-specific:
 * it is an adaptor from isomorphic-git's file-ops vocabulary onto ours.
 * Living above the adapter (MET-118) means there is one copy to reason about
 * and the fs surface stays the only platform seam.
 */

/**
 * Held git locks, keyed `"<lockScope>::<name>"` where the scope is the
 * repo's gitdir. Module-level rather than per-host: locks must be shared
 * across every host for a repo, and previously the per-adapter `Set`
 * achieved that only because exactly one adapter instance exists per app.
 * Keying by gitdir (not workspace) matters because two repos share one
 * worktree — the user's repo at `<ws>/.git` and the history repo at
 * `<ws>/.notefig/.git` — and must never contend on each other's locks.
 */
const gitLocks = new Set<string>();

function toEpochMs(value: Date | number): number {
  if (value instanceof Date) {
    return value.getTime();
  }
  return value;
}

function requireSuccess<T>(
  path: string,
  result: BatchResult<T>,
  errorKind: "read" | "write",
): T {
  if (result.succeeded.length > 0) {
    return result.succeeded[0];
  }

  const failed = result.failed[0];
  const reason = failed?.message ?? "Unknown error";
  throw new Error(`Git host ${errorKind} failed for '${path}': ${reason}`);
}

/**
 * Create a GitStorageHost on demand — callers build one per repo when git
 * work starts, never eagerly at open. `lockScope` is the repo's gitdir
 * (e.g. `<ws>/.git` or `<ws>/.notefig/.git`): it namespaces the lock
 * registry so repos sharing a worktree never contend.
 */
export function createGitStorageHost(
  fs: FileSystemSurface,
  lockScope: string,
): GitStorageHost {
  // isomorphic-git builds paths as `dir + "/" + filepath` — against a native
  // Windows dir that yields mixed-separator forms (`C:\ws/notes.md`), so
  // every incoming path is renormalized to native spelling at this seam.
  // Identity on posix.
  const native = (p: string) => pathutil.normalize(p);

  const host: GitStorageHost = {
    readFile: async (rawPath: string): Promise<Uint8Array> => {
      const path = native(rawPath);
      const result = await fs.readBinaryFiles([path]);
      const entry = requireSuccess(path, result, "read");
      return entry.data;
    },

    writeFileAtomic: async (
      rawPath: string,
      data: Uint8Array,
    ): Promise<void> => {
      const path = native(rawPath);
      const result = await fs.writeBinaryFiles([{ path, data }]);
      requireSuccess(path, result, "write");
    },

    renameAtomic: async (rawFrom: string, rawTo: string): Promise<void> => {
      const from = native(rawFrom);
      const to = native(rawTo);
      const result = await fs.moveFile(from, to);
      if (!result.ok) {
        throw new Error(
          `Git host rename failed for '${from}' -> '${to}': ${result.error.message}`,
        );
      }
    },

    deleteFile: async (rawPath: string): Promise<void> => {
      const path = native(rawPath);
      const result = await fs.deleteFiles([path]);
      requireSuccess(path, result, "write");
    },

    stat: async (rawPath: string) => {
      const path = native(rawPath);
      const exists = await fs.exists([path]);
      const entry = exists[0];
      if (!entry?.exists) {
        return {
          exists: false as const,
          isFile: false as const,
          isDir: false as const,
        };
      }

      const metadataResult = await fs.getMetadata([path]);
      const metadata = requireSuccess(path, metadataResult, "read");
      const isDir = metadata.type === "directory";

      return {
        exists: true as const,
        isFile: !isDir,
        isDir,
        size: metadata.size,
        mode: isDir ? 0o040755 : 0o100644,
        mtimeMs: toEpochMs(metadata.modifiedAt),
      };
    },

    lstat: async (path: string) => {
      const info = await host.stat(path);
      if (!info.exists) {
        return {
          exists: false as const,
          isFile: false as const,
          isDir: false as const,
          isSymbolicLink: false as const,
        };
      }

      return {
        ...info,
        isSymbolicLink: false,
      };
    },

    readDir: async (rawPath: string) => {
      const path = native(rawPath);
      const result = await fs.readDirectory(path, {
        recursive: false,
        includeFiles: true,
        includeDirectories: true,
        includeHidden: true,
      });

      if (!result.ok) {
        throw new Error(
          `Git host readdir failed for '${path}': ${result.error.message}`,
        );
      }

      const childExists = await fs.exists(result.value);
      return childExists
        .filter((entry) => entry.exists)
        .map((entry) => ({
          name: pathutil.basename(entry.path) || entry.path,
          isFile: entry.type === "file",
          isDir: entry.type === "directory",
          isSymbolicLink: false,
        }));
    },

    createDir: async (rawPath: string): Promise<void> => {
      const path = native(rawPath);
      const result = await fs.createDirectories([path]);
      requireSuccess(path, result, "write");
    },

    removeDir: async (rawPath: string): Promise<void> => {
      const path = native(rawPath);
      const result = await fs.deleteDirectories([path], {
        recursive: false,
      });
      requireSuccess(path, result, "write");
    },

    // Symlinks and modes have no representation on either backend: Tauri's
    // fs commands don't expose them and the FS Access API has no concept of
    // them at all. isomorphic-git only reaches for these on repos that
    // contain symlinks or mode changes, which we never author.
    readLink: async () => {
      throw new Error("Git host readLink is not supported on this adapter.");
    },

    createSymlink: async () => {
      throw new Error(
        "Git host createSymlink is not supported on this adapter.",
      );
    },

    chmod: async () => {
      throw new Error("Git host chmod is not supported on this adapter.");
    },

    lock: async (name: string): Promise<void> => {
      const key = `${lockScope}::${name}`;
      if (gitLocks.has(key)) {
        throw new Error(`Git lock '${name}' is already held.`);
      }
      gitLocks.add(key);
    },

    unlock: async (name: string): Promise<void> => {
      gitLocks.delete(`${lockScope}::${name}`);
    },
  };

  return host;
}
