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
import { sliceTextWindow, type AcpFileSystem } from '../agent';

/** Thrown for both containment violations and underlying fs failures, so a
 *  caller renders one readable message instead of a Node errno stack. */
export class HostFsError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = 'HostFsError';
  }
}

/**
 * Resolve a harness-supplied path and refuse anything outside the workspace.
 *
 * The path arrives over the wire from a process we spawned but do not
 * control, so `../` traversal is reachable input, not a theoretical case.
 * Desktop asserts an absolute-path invariant for the same reason
 * (assertAbsoluteWorkspacePath); a headless host has no dialog to fall back
 * on, so it declines instead.
 */
function resolveWithin(workspacePath: string, target: string): string {
  const resolved = path.resolve(workspacePath, target);
  const relative = path.relative(workspacePath, resolved);
  const escapes =
    relative.startsWith('..' + path.sep) ||
    relative === '..' ||
    path.isAbsolute(relative);
  if (escapes) {
    throw new HostFsError(
      target,
      `refusing to access a path outside the workspace: ${target}`,
    );
  }
  return resolved;
}

/**
 * Build the ACP client's fs dependency for a workspace. Every path the
 * harness names is resolved relative to — and confined to — that workspace.
 */
export function createNodeAcpFileSystem(workspacePath: string): AcpFileSystem {
  return {
    async readTextFile(
      target: string,
      options?: { line?: number; limit?: number },
    ): Promise<string> {
      const resolved = resolveWithin(workspacePath, target);
      let content: string;
      try {
        content = await fs.readFile(resolved, 'utf8');
      } catch (error: any) {
        throw new HostFsError(
          target,
          `could not read ${target}: ${error?.message ?? error}`,
        );
      }
      return sliceTextWindow(content, options);
    },

    async writeTextFile(target: string, content: string): Promise<void> {
      const resolved = resolveWithin(workspacePath, target);
      try {
        // Harnesses create files in directories they just decided to add.
        await fs.mkdir(path.dirname(resolved), { recursive: true });
        await fs.writeFile(resolved, content, 'utf8');
      } catch (error: any) {
        throw new HostFsError(
          target,
          `could not write ${target}: ${error?.message ?? error}`,
        );
      }
    },
  };
}
