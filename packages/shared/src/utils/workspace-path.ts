/**
 * Workspace path resolution: one containment rule, for every consumer.
 *
 * A path handed to us by an agent — over ACP, or as a tool argument — is
 * input from a process we spawned but do not control, so `..` traversal and
 * absolute paths pointing anywhere on the disk are reachable cases rather
 * than theoretical ones. Deciding what those mean is a protocol decision,
 * not a platform one, so it happens here once.
 *
 * This absorbs what were two implementations of the same job:
 * `resolveWithinWorkspace` in the ACP bridge (throwing, absolute-only
 * result) and `resolveWorkspacePath` in the desktop's `utils/fs` (errors as
 * values, `{ absolute, relative }` result). They agreed on intent and
 * differed in mechanism, which is exactly the kind of drift the bridge
 * unification was meant to end — the tool domain simply hadn't been counted
 * as a fifth path vocabulary.
 *
 * Errors-as-values is the base shape because the tool domain needs to turn
 * a refusal into an answer for the agent rather than an exception; the ACP
 * bridge wraps it back into a throw at its own seam.
 */
import type { PathFlavor } from "./pathutil";

export type WorkspacePathResolution =
  | { ok: true; absolute: string; relative: string }
  | { ok: false; error: string };

/**
 * Resolve an agent-supplied document path against a workspace root.
 *
 * Relative paths ("notes.md" — what the tool schemas ask for) resolve
 * against the root; absolute ones are accepted and checked. The result is
 * always `{ absolute, relative }`, with `relative` in the `/`-separated
 * tree-path domain every consumer downstream expects (tool results,
 * metadata rows, tree paths).
 *
 * Containment is enforced structurally rather than by string prefix, so a
 * sibling directory sharing the root's name (`/ws-backup` against `/ws`) is
 * refused rather than accepted.
 *
 * This exists because an unresolved relative path reaches the OS resolved
 * against the *process CWD* — under `cargo tauri dev` that is `src-tauri/`,
 * so an agent authoring "canto-ii.md" wrote into the app's own source tree
 * and the dev watcher restarted the app on every question.
 */
export function resolveWorkspacePath(
  flavor: PathFlavor,
  workspacePath: string,
  inputPath: string,
): WorkspacePathResolution {
  const root = flavor.normalize(workspacePath);
  // Agent-supplied relative paths are "/"-separated (the tool schemas'
  // contract) — tree-domain, converted to native before joining.
  const joined = flavor.isAbsolute(inputPath)
    ? flavor.normalize(inputPath)
    : flavor.join(root, flavor.fromTreePath(inputPath));

  // Collapse "." and ".." segments so escapes are caught structurally, in
  // forward-slash space so one loop serves both flavors. `PathFlavor.join`
  // and `normalize` deliberately do not collapse (their contract says
  // containment logic must do it explicitly), because collapsing is only
  // correct once you have decided what a traversal out of the root means.
  // The filesystem-root segments can never be popped:
  //   posix  /a/b        → [""]        win32  C:/a → ["C:"]
  //   UNC    //srv/sh/a  → ["", "", "srv", "sh"]
  const posixForm = flavor.toPosixAbsolute(joined);
  const parts = posixForm.split("/");
  const rootCount = posixForm.startsWith("//") ? 4 : 1;
  const kept = parts.slice(0, rootCount);
  const segments: string[] = [];
  for (const segment of parts.slice(rootCount)) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) {
        return { ok: false, error: `path escapes the workspace: ${inputPath}` };
      }
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  const absolute = flavor.normalize([...kept, ...segments].join("/"));

  const relativeNative = flavor.relative(root, absolute);
  if (relativeNative === undefined) {
    return {
      ok: false,
      error: `path is outside the workspace (${workspacePath}): ${inputPath}`,
    };
  }
  return { ok: true, absolute, relative: flavor.toTreePath(relativeNative) };
}
