/**
 * What the sync worker calls back into on the main thread: the fs slice
 * git's storage host needs, and the git HTTP transport. Errors cross as
 * data: an `FsError` keeps its discriminant (git maps a missing file by
 * it), anything else its message.
 */
import type { GitHttpRequest, GitHttpResponse } from "@notefig/git";
import type { GitHostFs } from "@/adapters/git-storage-host";
import {
  FsError,
  type FileSystemErrorType,
  type IPlatformAdapter,
} from "@/adapters/platform-adapter.interface";

export type SyncHostApi = GitHostFs & {
  gitHttp(request: GitHttpRequest): Promise<GitHttpResponse>;
};

/** The host API over the platform. */
export function syncHostApi(
  platform: Pick<IPlatformAdapter, "fs" | "gitHttp">,
): SyncHostApi {
  const { fs, gitHttp } = platform;
  return {
    readBinaryFiles: (paths) => fs.readBinaryFiles(paths),
    writeBinaryFiles: (files) => fs.writeBinaryFiles(files),
    moveFile: (oldPath, newPath) => fs.moveFile(oldPath, newPath),
    deleteFiles: (paths) => fs.deleteFiles(paths),
    getMetadata: (paths) => fs.getMetadata(paths),
    readDirectory: (path, options) => fs.readDirectory(path, options),
    createDirectories: (paths) => fs.createDirectories(paths),
    deleteDirectories: (paths, options) => fs.deleteDirectories(paths, options),
    gitHttp: (request) => gitHttp.request(request),
  };
}

interface SerializedFsError {
  fsError: { type: FileSystemErrorType; path: string; message?: string };
}

export function serializeHostError(error: unknown): unknown {
  if (error instanceof FsError) {
    return {
      fsError: { type: error.type, path: error.path, message: error.message },
    } satisfies SerializedFsError;
  }
  return error instanceof Error ? error.message : String(error);
}

export function reviveHostError(error: unknown): Error {
  const fsError = (error as Partial<SerializedFsError> | null)?.fsError;
  if (fsError && typeof fsError.type === "string") {
    return new FsError(fsError.type, fsError.path, fsError.message);
  }
  return new Error(typeof error === "string" ? error : "Host call failed");
}
