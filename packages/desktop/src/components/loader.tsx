import { useEffect } from "react";
import { useWorkspaceParams } from "@/hooks/use-workspace-params";
import { openWorkspace } from "@/entities/workspaces";
import { ensureWatching } from "@/utils/workspace-watchers";

export function Loader({ children }: { children: React.ReactNode }) {
  const { workspacePath } = useWorkspaceParams();

  useEffect(() => {
    if (!workspacePath) {
      return;
    }

    // Registers the workspace as open (idempotent): seeds collections and
    // kicks the listing walk. Close is explicit (entities/workspaces.ts),
    // not tied to this component's lifetime.
    openWorkspace(workspacePath);
    // Arming the watcher is the subscription's job, driven by the row this
    // just inserted. What only re-entry can do is retry a watcher whose
    // start failed because the workspace was unreadable at the time.
    ensureWatching(workspacePath);
  }, [workspacePath]);

  if (!workspacePath) {
    return null;
  }

  // Render children immediately - collections are created synchronously
  // Data will load in the background and components will reactively update
  return <>{children}</>;
}
