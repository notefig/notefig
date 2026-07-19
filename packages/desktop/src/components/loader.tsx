import { useEffect } from "react";
import { useWorkspaceParams } from "@/hooks/use-workspace-params";
import {
  getOrCreateWorkspaceCollections,
  refreshDirectoryMetadata,
} from "@/entities/files";

export function Loader({ children }: { children: React.ReactNode }) {
  const { workspacePath } = useWorkspaceParams();

  useEffect(() => {
    // Early return if no workspace path
    if (!workspacePath) {
      return;
    }

    // Create/get collections for this workspace
    // This ensures the collections exist before children render
    getOrCreateWorkspaceCollections(workspacePath);

    // Load initial metadata
    // This will populate the metadata collection with all files in the workspace
    refreshDirectoryMetadata(workspacePath);
  }, [workspacePath]);

  // Don't render children if no workspace path
  if (!workspacePath) {
    return null;
  }

  // Render children immediately - collections are created synchronously
  // Data will load in the background and components will reactively update
  return <>{children}</>;
}
