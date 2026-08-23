import { posix, win32, type PathFlavor } from "@notefig/shared/utils";
import { getDesktopOs } from "./platform";

/**
 * The app's bound path flavor (MET-157 B2): win32 iff the Tauri shell runs
 * on Windows, posix everywhere else — including web on a Windows host, whose
 * browser adapters use synthetic posix roots. Decided by the same
 * platform-detection signal the adapter factory uses, so the flavor and the
 * adapter can never disagree.
 *
 * `toKey` is for Map/registry keys and comparisons only; never persist or
 * display its output. Tree/ignore/git/mention/URL domains stay `/`-separated
 * — convert at their seams with `toTreePath`/`fromTreePath`.
 */
export const path: PathFlavor =
  getDesktopOs() === "windows" ? win32 : posix;

export { posix, win32, type PathFlavor };

/**
 * Tree-domain ("/"-separated) path of `absolutePath` relative to `root`;
 * "" for the root itself, undefined when outside it. The one derivation
 * every relativePath row / tree path / mention token goes through — replaces
 * the historical `startsWith(root) ? slice(root.length + 1) : undefined`
 * pattern (which also mis-sliced sibling prefixes like `/ws-backup`).
 */
/**
 * THE canonical key for anything registry- or persistence-keyed by a
 * workspace path: TaskManager, trust, blob sessions, task rows, git query
 * keys, history services. Identity on posix — the spelling mac already
 * persists never changes — and normalized+lowercased native on Windows, so
 * `C:\Foo` and `c:/foo` collapse to one workspace. Replaces the historical
 * `normalizePath(workspacePath)` keys (identical output for the absolute
 * paths real mac routes carry).
 */
export function workspaceKey(workspacePath: string): string {
  // normalize first: the historical normalizePath keys collapsed duplicate
  // and trailing slashes ("/ws/" and "/ws" are one workspace), and toKey is
  // spelling-preserving on posix.
  return path.toKey(path.normalize(workspacePath));
}

export function relativeTreePath(
  root: string,
  absolutePath: string,
): string | undefined {
  const relative = path.relative(root, absolutePath);
  return relative === undefined ? undefined : path.toTreePath(relative);
}
