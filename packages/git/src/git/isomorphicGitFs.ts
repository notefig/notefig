import type { FsClient } from "isomorphic-git";
import { Buffer } from "buffer";

import type { GitStorageHost } from "./types";

type FsStatLike = {
  ctime: Date;
  mtime: Date;
  ctimeMs: number;
  mode: number;
  mtimeMs: number;
  dev: number;
  ino: number;
  uid: number;
  gid: number;
  size: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
};

type StatInput = {
  exists: boolean;
  isFile: boolean;
  isDir: boolean;
  isSymbolicLink?: boolean;
  mode?: number;
  mtimeMs?: number;
  size?: number;
};

function normalizeBuffer(data: Uint8Array): Uint8Array {
  if (
    data.byteOffset === 0 &&
    data.byteLength === data.buffer.byteLength &&
    data.constructor === Uint8Array
  ) {
    return data;
  }

  return new Uint8Array(data);
}

function toBuffer(data: Uint8Array): Buffer {
  const normalized = normalizeBuffer(data);
  return Buffer.from(
    normalized.buffer,
    normalized.byteOffset,
    normalized.byteLength,
  );
}

function toFsError(code: string, message: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

function assertExistingStatFields(input: StatInput): asserts input is {
  exists: true;
  isFile: boolean;
  isDir: boolean;
  isSymbolicLink?: boolean;
  mode: number;
  mtimeMs: number;
  size: number;
} {
  if (!input.exists) {
    return;
  }

  if (
    typeof input.mode !== "number" ||
    typeof input.mtimeMs !== "number" ||
    typeof input.size !== "number"
  ) {
    throw toFsError(
      "EIO",
      "Invalid GitStorageHost stat payload: mode, mtimeMs, and size are required when exists=true",
    );
  }
}

function toStatLike(input: StatInput): FsStatLike {
  if (!input.exists) {
    throw toFsError("ENOENT", "Path does not exist");
  }

  assertExistingStatFields(input);

  return {
    ctime: new Date(input.mtimeMs),
    mtime: new Date(input.mtimeMs),
    ctimeMs: input.mtimeMs,
    mode: input.mode,
    mtimeMs: input.mtimeMs,
    dev: 1,
    ino: 1,
    uid: 0,
    gid: 0,
    size: input.size,
    isFile: () => input.isFile,
    isDirectory: () => input.isDir,
    isSymbolicLink: () => input.isSymbolicLink ?? false,
  };
}

type ReaddirEntry = {
  name: string;
  isFile: () => boolean;
  isDirectory: () => boolean;
  isSymbolicLink: () => boolean;
};

function normalizeEncoding(
  encoding: BufferEncoding | "binary" | "buffer" | null | undefined,
): BufferEncoding | "buffer" | null {
  if (encoding === "binary") {
    return "latin1";
  }

  return encoding ?? null;
}

function extractEncoding(
  options?:
    | BufferEncoding
    | "binary"
    | "buffer"
    | { encoding?: BufferEncoding | "binary" | "buffer" | null }
    | null,
): BufferEncoding | "buffer" | null {
  if (!options) {
    return null;
  }

  if (typeof options === "string") {
    return normalizeEncoding(options);
  }

  return normalizeEncoding(options.encoding);
}

/** Packs are read in blocks this big, so neighbouring objects (a tree
 *  walk's trees, a commit's history) share one host call. */
const PACK_BLOCK = 64 * 1024;
/** Blocks kept per fs, oldest dropped first: 16 MB. */
const PACK_BLOCKS_KEPT = 256;
/** A pack is named by its content, so its bytes never change. */
const PACKFILE = /\/objects\/pack\/pack-[0-9a-f]{40}\.pack$/;

/**
 * Ranged reads of packfiles for the patched isomorphic-git
 * (`patches/isomorphic-git+*.patch`), which reads a pack an object at a
 * time instead of whole. Cached in blocks; a range past a few blocks (a
 * large blob) is read directly.
 */
function createRangeReader(host: GitStorageHost) {
  const blocks = new Map<string, Promise<Uint8Array>>();
  const block = (path: string, index: number) => {
    const key = `${index}:${path}`;
    let data = blocks.get(key);
    if (data) {
      blocks.delete(key);
    } else {
      data = host.readFileRange(path, index * PACK_BLOCK, (index + 1) * PACK_BLOCK);
      data.catch(() => blocks.delete(key));
      if (blocks.size >= PACK_BLOCKS_KEPT) blocks.delete(blocks.keys().next().value!);
    }
    blocks.set(key, data);
    return data;
  };
  return async (path: string, start: number, end: number): Promise<Buffer> => {
    const first = Math.floor(start / PACK_BLOCK);
    const last = Math.floor(Math.max(start, end - 1) / PACK_BLOCK);
    if (!PACKFILE.test(path) || last - first >= 4) {
      return toBuffer(await host.readFileRange(path, start, end));
    }
    const parts = await Promise.all(
      Array.from({ length: last - first + 1 }, (_, at) => block(path, first + at)),
    );
    const joined = parts.length === 1 ? parts[0] : Buffer.concat(parts);
    const from = start - first * PACK_BLOCK;
    return toBuffer(joined.subarray(from, from + (end - start)));
  };
}

export function createIsomorphicGitFs(host: GitStorageHost): FsClient {
  const promises = {
    readFileRange: createRangeReader(host),

    async readFile(
      path: string,
      options?:
        | BufferEncoding
        | "buffer"
        | { encoding?: BufferEncoding | "buffer" | null }
        | null,
    ): Promise<Buffer | string> {
      const data = await host.readFile(path);
      const encoding = extractEncoding(options);
      const buffer = toBuffer(data);

      if (encoding && encoding !== "buffer") {
        return buffer.toString(encoding);
      }

      return buffer;
    },

    async writeFile(
      path: string,
      data: string | Uint8Array,
      options?:
        | BufferEncoding
        | "buffer"
        | "binary"
        | { encoding?: BufferEncoding | "binary" | "buffer" | null }
        | null,
    ): Promise<void> {
      const encoding = extractEncoding(options);
      const bytes =
        typeof data === "string"
          ? new Uint8Array(
              Buffer.from(
                data,
                encoding && encoding !== "buffer" ? encoding : "utf8",
              ),
            )
          : normalizeBuffer(data);

      await host.writeFileAtomic(path, bytes);
    },

    async unlink(path: string): Promise<void> {
      await host.deleteFile(path);
    },

    async readdir(
      path: string,
      options?: { withFileTypes?: boolean } | null,
    ): Promise<string[] | ReaddirEntry[]> {
      const entries = await host.readDir(path);
      if (options?.withFileTypes) {
        return entries.map((entry) => ({
          name: entry.name,
          isFile: () => entry.isFile,
          isDirectory: () => entry.isDir,
          isSymbolicLink: () => entry.isSymbolicLink,
        }));
      }

      return entries.map((entry) => entry.name);
    },

    async mkdir(
      path: string,
      _options?: { recursive?: boolean } | number,
    ): Promise<void> {
      await host.createDir(path);
    },

    async rmdir(path: string): Promise<void> {
      await host.removeDir(path);
    },

    async stat(path: string): Promise<FsStatLike> {
      const info = await host.stat(path);
      return toStatLike(info);
    },

    async lstat(path: string): Promise<FsStatLike> {
      const info = await host.lstat(path);
      return toStatLike(info);
    },

    async readlink(path: string): Promise<string> {
      return host.readLink(path);
    },

    async symlink(target: string, path: string): Promise<void> {
      await host.createSymlink(target, path);
    },

    async chmod(path: string, mode: number): Promise<void> {
      await host.chmod(path, mode);
    },

    async rename(from: string, to: string): Promise<void> {
      await host.renameAtomic(from, to);
    },
  };

  return { promises };
}
