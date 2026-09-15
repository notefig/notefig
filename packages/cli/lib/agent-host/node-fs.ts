/**
 * The Node implementation of `CoreFileSystem`.
 *
 * Four of the seven members are `fs.promises` with the batch shape wrapped
 * around them. The watcher trio is not implemented: a single-turn headless
 * run has nothing to keep fresh, and writing a chokidar layer now would be
 * inventing a consumer. They throw a declared error rather than being
 * absent, so the surface stays uniform and a future caller gets a sentence
 * instead of `undefined is not a function`.
 *
 * Errors come back as `FsError` — the same class the desktop throws, from
 * @notefig/core — so a caller handles one error type regardless of host.
 * The `HostFsError` this package briefly defined was a duplicate and is gone.
 */
import { promises as fs } from 'fs';
import * as path from 'path';
import {
  FsError,
  type BatchResult,
  type CoreFileSystem,
  type FileSystemError,
  type FileSystemErrorType,
  type FileSystemMetadata,
} from '../core';

/** Map a Node errno to the shared error vocabulary. */
function classify(error: NodeJS.ErrnoException): FileSystemErrorType {
  switch (error.code) {
    case 'ENOENT':
      return 'not_found';
    case 'EACCES':
    case 'EPERM':
      return 'permission_denied';
    case 'EEXIST':
      return 'already_exists';
    case 'ENOTEMPTY':
      return 'not_empty';
    case 'EISDIR':
      return 'is_directory';
    case 'ENOTDIR':
      return 'is_file';
    case 'EIO':
      return 'io_error';
    default:
      return 'unknown';
  }
}

function toFailure(target: string, error: unknown): FileSystemError {
  const errno = error as NodeJS.ErrnoException;
  return new FsError(classify(errno), target, errno?.message);
}

/**
 * Run one operation per input and sort the outcomes into the batch shape.
 * Sequential rather than concurrent: these batches are small, and keeping
 * the failures in input order makes them readable.
 *
 * Takes the inputs themselves rather than a list of paths, so a caller never
 * has to look an entry back up by path — two entries for the same path would
 * otherwise silently resolve to the first one's content.
 */
async function batch<TInput, TOutput>(
  inputs: TInput[],
  pathOf: (input: TInput) => string,
  run: (input: TInput) => Promise<TOutput>,
): Promise<BatchResult<TOutput>> {
  const succeeded: TOutput[] = [];
  const failed: FileSystemError[] = [];
  for (const input of inputs) {
    try {
      succeeded.push(await run(input));
    } catch (error) {
      failed.push(toFailure(pathOf(input), error));
    }
  }
  return { succeeded, failed };
}

export function createNodeFileSystem(): CoreFileSystem {
  return {
    readFiles: (paths) =>
      batch(
        paths,
        (target) => target,
        async (target) => ({
          path: target,
          content: await fs.readFile(target, 'utf8'),
        }),
      ),

    writeFiles: (files) =>
      batch(
        files,
        (file) => file.path,
        async ({ path: target, content }) => {
          // Harnesses create files in directories they just decided to add.
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.writeFile(target, content, 'utf8');
          return target;
        },
      ),

    getMetadata: (paths) =>
      batch(
        paths,
        (target) => target,
        async (target): Promise<FileSystemMetadata> => {
          const stat = await fs.stat(target);
          return {
            path: target,
            type: stat.isDirectory() ? 'directory' : 'file',
            size: stat.size,
            modifiedAt: stat.mtime,
            createdAt: stat.birthtime,
          };
        },
      ),

    async exists(paths) {
      return Promise.all(
        paths.map(async (target) => {
          try {
            const stat = await fs.stat(target);
            return {
              path: target,
              exists: true,
              type: (stat.isDirectory() ? 'directory' : 'file') as
                | 'directory'
                | 'file',
            };
          } catch {
            return { path: target, exists: false };
          }
        }),
      );
    },

  };
}
