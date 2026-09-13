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
 * only the bytes, through `CoreFileSystem`; the desktop layers editor
 * adoption on top of the write, which is the one genuine per-host
 * difference and arrives as `afterWrite`.
 */
import { sliceTextWindow } from "@notefig/agent";
import type { PathFlavor } from "@notefig/shared/utils";
import { FsError, type CoreFileSystem } from "./fs";

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
  /**
   * Applied after the bytes reach disk. The desktop passes the adoption step
   * that pushes content into a live editor; a headless host passes nothing.
   */
  afterWrite?: (absolutePath: string, content: string) => Promise<void>;
};

/**
 * Collapse `.` and `..` segments. `PathFlavor.join`/`normalize` deliberately
 * do not (their contract says containment logic must collapse explicitly),
 * because collapsing is only correct once you have decided what a traversal
 * out of the root means — which is this function's job.
 */
function collapse(flavor: PathFlavor, path: string): string {
  const absolute = flavor.isAbsolute(path);
  const separator = flavor.sep;
  const parts: string[] = [];
  // Accept mixed separators: win32 paths reach us with either.
  for (const segment of path.split(/[\\/]/)) {
    if (segment === "" || segment === ".") continue;
    if (segment === ".." && parts.length > 0 && parts[parts.length - 1] !== "..") {
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  const joined = parts.join(separator);
  // A leading separator is meaningful on posix and on win32 UNC/rooted
  // paths; normalize() restores the flavor's canonical spelling either way.
  return flavor.normalize(absolute && !/^[A-Za-z]:/.test(joined) ? `${separator}${joined}` : joined);
}

/**
 * Resolve a harness-supplied path and refuse anything outside the workspace.
 *
 * The path arrives over the wire from a process we spawned but do not
 * control, so `../` traversal is reachable input rather than a theoretical
 * case. Relative paths resolve against the workspace root — harnesses emit
 * them routinely — which is why the desktop's absolute-only assertion could
 * not simply be adopted for both hosts.
 */
export function resolveWithinWorkspace(
  flavor: PathFlavor,
  workspacePath: string,
  target: string,
): string {
  const root = flavor.normalize(workspacePath);
  const joined = flavor.isAbsolute(target)
    ? target
    : flavor.join(root, target);
  const resolved = collapse(flavor, joined);
  const inside =
    flavor.toKey(resolved) === flavor.toKey(root) ||
    flavor.contains(root, resolved);
  if (!inside) {
    throw new FsError(
      "invalid_path",
      target,
      `refusing to access a path outside the workspace: ${target}`,
    );
  }
  return resolved;
}

export function createAcpFileSystem(
  fs: CoreFileSystem,
  options: AcpBridgeOptions,
): AcpFileSystemBridge {
  const { workspacePath, path: flavor, afterWrite } = options;
  return {
    async readTextFile(target, window) {
      const resolved = resolveWithinWorkspace(flavor, workspacePath, target);
      const result = await fs.readFiles([resolved]);
      const failure = result.failed[0];
      if (failure) {
        throw new FsError(failure.type, failure.path, failure.message);
      }
      // ACP's 1-based line/limit window, applied identically on every host.
      return sliceTextWindow(result.succeeded[0].content, window);
    },

    async writeTextFile(target, content) {
      const resolved = resolveWithinWorkspace(flavor, workspacePath, target);
      const result = await fs.writeFiles([{ path: resolved, content }]);
      const failure = result.failed[0];
      if (failure) {
        throw new FsError(failure.type, failure.path, failure.message);
      }
      await afterWrite?.(resolved, content);
    },
  };
}
