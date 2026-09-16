/**
 * Workspace containment for the ACP file-system methods.
 *
 * ACP hands a harness two file operations, `fs/read_text_file` and
 * `fs/write_text_file`, and the path in each is input from a process we
 * spawned but do not control. `../` traversal and absolute paths pointing
 * anywhere on the disk are therefore reachable cases, not theoretical ones.
 *
 * Deciding what those mean is a decision about the protocol, not about a
 * platform, which is why it lives in this package rather than in either
 * host. Before this existed the two hosts had drifted on all three points a
 * harness can feel:
 *
 *   relative paths   the CLI resolved them; the desktop threw
 *   `../` escapes    the CLI refused them; the desktop did not check at all
 *   absolute escapes the CLI refused them; the desktop wrote the file
 *
 * This is a wrapper rather than a replacement on purpose. Everything a host
 * does per write — the desktop's rename redirect, tracked-write echo
 * suppression, content-row update and editor adoption — stays inside the
 * `AcpFileSystem` it passes in. Containment is the only thing added, and it
 * is added in front, where a path can still be refused before any of that
 * work begins.
 */
import {
  resolveWorkspacePath,
  type PathFlavor,
} from "@notefig/shared/utils";
import type { AcpFileSystem } from "./acp-client";

/**
 * A harness-supplied path that does not resolve inside the workspace.
 *
 * ACP has no "refused" result shape — a bad path is an error response — so
 * the containment decision, which `resolveWorkspacePath` returns as a value,
 * becomes a throw at this seam. It carries the path so a host can log which
 * harness asked for what.
 */
export class AcpPathError extends Error {
  readonly name = "AcpPathError";
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(message);
  }
}

export type WorkspaceContainmentOptions = {
  /** Absolute workspace root. Every harness-supplied path resolves within it. */
  workspacePath: string;
  /**
   * The host's bound path flavor — win32 on a Windows shell, posix
   * elsewhere. Supplied rather than detected: this package has no way to ask
   * the OS, and the detection is a decision each host already makes.
   */
  path: PathFlavor;
};

/**
 * Wrap an `AcpFileSystem` so every path is resolved against the workspace
 * root and refused if it lands outside.
 *
 * Relative paths ("notes.md" — what the tool schemas ask for) resolve
 * against the root, so the inner implementation always receives an absolute
 * path it can act on. Containment is structural rather than a string prefix
 * test, so a sibling directory sharing the root's name (`/ws-backup` against
 * `/ws`) is refused rather than accepted.
 */
export function withWorkspaceContainment(
  fs: AcpFileSystem,
  options: WorkspaceContainmentOptions,
): AcpFileSystem {
  const { workspacePath, path: flavor } = options;

  const resolve = (target: string): string => {
    const resolved = resolveWorkspacePath(flavor, workspacePath, target);
    if (!resolved.ok) {
      throw new AcpPathError(target, resolved.error);
    }
    return resolved.absolute;
  };

  // `async` rather than a bare arrow on purpose: `resolve` throws, and the
  // contract here is promise-returning. A synchronous throw would escape a
  // caller that only attached `.catch()`, which is a different failure from
  // the rejection every other path in this interface produces.
  return {
    async readTextFile(target, readOptions) {
      return fs.readTextFile(resolve(target), readOptions);
    },
    async writeTextFile(target, content) {
      return fs.writeTextFile(resolve(target), content);
    },
  };
}
