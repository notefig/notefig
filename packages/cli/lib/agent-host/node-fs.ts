/**
 * The Node implementation of the `fs` surface, cut down to what an ACP
 * session actually calls: `fs/read_text_file` and `fs/write_text_file`. The
 * full surface (metadata, search, watching) belongs to the core extraction
 * (MET-183); building it here would be inventing consumers.
 *
 * Desktop's equivalent is readWorkspaceTextFile / writeWorkspaceTextFile in
 * packages/desktop/src/utils/file-sync.ts, which additionally adopt writes
 * into live editors. A headless host has no editors, so this is the same
 * contract minus the adoption — the line/limit slicing is kept identical so
 * a harness sees the same bytes either way.
 */
import { promises as fs } from 'fs';
import * as path from 'path';
import {
  sliceTextWindow,
  withWorkspaceContainment,
  type AcpFileSystem,
} from '../agent';
import { posix, win32 } from '../shared';

/** Thrown for underlying fs failures, so a caller renders one readable
 *  message instead of a Node errno stack. Containment refusals come from the
 *  shared wrapper as `AcpPathError`. */
export class HostFsError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = 'HostFsError';
  }
}

/** This process's path flavor, for the shared containment rule. */
export const nodePathFlavor = process.platform === 'win32' ? win32 : posix;

/**
 * Write files, creating parent directories, reporting failures as values —
 * the shape a harness invoke hook expects (`HarnessInvokeContext.writeFiles`).
 */
export async function writeNodeFiles(
  files: { path: string; content: string }[],
): Promise<{ failed: { path: string; message: string }[] }> {
  const failed: { path: string; message: string }[] = [];
  for (const file of files) {
    try {
      await fs.mkdir(path.dirname(file.path), { recursive: true });
      await fs.writeFile(file.path, file.content, 'utf8');
    } catch (error: any) {
      failed.push({ path: file.path, message: error?.message ?? String(error) });
    }
  }
  return { failed };
}

/**
 * Build the ACP client's fs dependency for a workspace.
 *
 * Containment is the shared rule from `@notefig/agent` — the same wrapper the
 * desktop puts in front of its write path — so a harness-supplied path is
 * resolved and refused identically on both hosts. What is left here is only
 * the bytes: by the time these run, every path is absolute and inside the
 * workspace.
 */
export function createNodeAcpFileSystem(workspacePath: string): AcpFileSystem {
  const raw: AcpFileSystem = {
    async readTextFile(target, options) {
      let content: string;
      try {
        content = await fs.readFile(target, 'utf8');
      } catch (error: any) {
        throw new HostFsError(
          target,
          `could not read ${target}: ${error?.message ?? error}`,
        );
      }
      return sliceTextWindow(content, options);
    },

    async writeTextFile(target, content) {
      const { failed } = await writeNodeFiles([{ path: target, content }]);
      if (failed.length > 0) {
        throw new HostFsError(
          target,
          `could not write ${target}: ${failed[0].message}`,
        );
      }
    },
  };
  return withWorkspaceContainment(raw, {
    workspacePath,
    path: nodePathFlavor,
  });
}
