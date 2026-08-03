/**
 * The sentinel workspace id for no-workspace (loose-file-only) editing.
 *
 * Loose files opened with no folder open live in a workspace keyed by this
 * sentinel: the whole collections/watcher/tab machinery is reused, with the
 * metadata queryFn skipping its directory walk (there is no root to scan).
 * A true leaf module — anything from routing to the entities layer may
 * import it without cycles.
 *
 * The trailing colon makes it an impossible absolute path, so it can never
 * collide with a real workspace directory, and any accidental
 * `${workspaceId}/...` concatenation produces a visibly bogus, non-absolute
 * path (rejected by assertAbsoluteWorkspacePath) instead of writing
 * somewhere real.
 */
import { LAYOUT_PARAM } from "./layout-codec";
import { createInitialLayout } from "./dockable-layout";

export const LOOSE_WORKSPACE_ID = "loose:";

export function isLooseWorkspace(
  workspaceId: string | null | undefined,
): boolean {
  return workspaceId === LOOSE_WORKSPACE_ID;
}

/** The route URL for editing a single loose file with no workspace open. */
export function buildLooseFileUrl(filePath: string): string {
  const params = new URLSearchParams();
  params.set(LAYOUT_PARAM, JSON.stringify(createInitialLayout(filePath)));
  return `/${encodeURIComponent(LOOSE_WORKSPACE_ID)}?${params.toString()}`;
}
