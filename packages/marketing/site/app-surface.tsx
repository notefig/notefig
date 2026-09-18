import { Workspace } from "@/components/workspace";
import { WorkspaceErrorBoundary } from "@/components/workspace-error-boundary";

/**
 * The real Workspace. Which workspace it shows is not a matter of URL — the
 * app is one dock over the open set, and this site's boot (main.tsx) opens
 * exactly one workspace, the seeded content root, so the shell focuses it.
 */
export function AppSurface() {
  return (
    <WorkspaceErrorBoundary>
      <Workspace />
    </WorkspaceErrorBoundary>
  );
}
