/**
 * The ACP file-system bridge: one implementation, over `CoreFileSystem`.
 *
 * ACP gives a harness two file operations, `fs/read_text_file` and
 * `fs/write_text_file`. Before this existed there were two bridges — the
 * desktop's `readWorkspaceTextFile`/`writeWorkspaceTextFile` and the CLI's
 * `node-fs.ts` — and they had drifted in three ways a harness could feel:
 *
 *   relative paths   CLI resolved them; desktop threw
 *   `../` escapes    CLI refused them; desktop did not check at all
 *   error type       CLI's HostFsError; desktop's FsError
 *
 * The same path string from the same harness therefore behaved differently
 * depending on which host it reached. Those are decisions about the
 * protocol, not about a platform, so they live here once. A host supplies
 * only the bytes, through `CoreFileSystem` — and that is the whole seam. The
 * desktop's extra per-write work (rename redirect, echo suppression, row
 * update, editor adoption) lives inside the `CoreFileSystem` it passes in,
 * not in a hook here: it has to happen within the desktop's own tracked
 * write, which an "after the bytes landed" callback cannot express.
 */
import type { PathFlavor } from "@notefig/shared/utils";
import { FsError, type CoreFileSystem } from "./fs";
import { resolveWorkspacePath } from "./paths";

/**
 * Apply ACP's `line`/`limit` read window to file content. Lines are 1-based
 * and `limit` counts lines, not bytes.
 *
 * Protocol semantics, so it belongs with the other protocol decisions in this
 * file — a harness must see the same slice whether the client runs in the
 * desktop webview or a headless Node process. It lived in `@notefig/agent`,
 * which made this six-line pure function the *only* value import core made
 * from another package, and so the reason `@notefig/agent` was a runtime
 * dependency of `@notefig/core` at all.
 */
export function sliceTextWindow(
  content: string,
  options?: { line?: number; limit?: number },
): string {
  if (!options?.line && !options?.limit) return content;
  const lines = content.split("\n");
  const start = Math.max(0, (options.line ?? 1) - 1);
  const end = options.limit ? start + options.limit : lines.length;
  return lines.slice(start, end).join("\n");
}

export type AcpFileSystemBridge = {
  readTextFile(
    path: string,
    options?: { line?: number; limit?: number },
  ): Promise<string>;
  writeTextFile(path: string, content: string): Promise<void>;
};

export type AcpBridgeOptions = {
  /** Absolute workspace root. Every harness-supplied path resolves within it. */
  workspacePath: string;
  /** The host's bound path flavor — win32 on a Windows shell, posix
   *  elsewhere. Supplied rather than detected: this package has no way to
   *  ask the OS, and detection is the host's existing decision (MET-157). */
  path: PathFlavor;
};

/**
 * The throwing face of `resolveWorkspacePath`, for the wire seam.
 *
 * ACP has no "refused" result shape — a bad path is an error response — so
 * the bridge converts the resolution's error value into the house `FsError`
 * here. The containment rule itself lives in `paths.ts` and is shared with
 * the tool domain, which needs the same decision as a value.
 */
export function resolveWithinWorkspace(
  flavor: PathFlavor,
  workspacePath: string,
  target: string,
): string {
  const resolved = resolveWorkspacePath(flavor, workspacePath, target);
  if (!resolved.ok) {
    throw new FsError("invalid_path", target, resolved.error);
  }
  return resolved.absolute;
}

export function createAcpFileSystem(
  fs: CoreFileSystem,
  options: AcpBridgeOptions,
): AcpFileSystemBridge {
  const { workspacePath, path: flavor } = options;
  return {
    async readTextFile(target, textWindow) {
      const resolved = resolveWithinWorkspace(flavor, workspacePath, target);
      const result = await fs.readFiles([resolved]);
      const failure = result.failed[0];
      if (failure) {
        throw new FsError(failure.type, failure.path, failure.message);
      }
      // ACP's 1-based line/limit window, applied identically on every host.
      return sliceTextWindow(result.succeeded[0].content, textWindow);
    },

    async writeTextFile(target, content) {
      const resolved = resolveWithinWorkspace(flavor, workspacePath, target);
      const result = await fs.writeFiles([{ path: resolved, content }]);
      const failure = result.failed[0];
      if (failure) {
        throw new FsError(failure.type, failure.path, failure.message);
      }
    },
  };
}
