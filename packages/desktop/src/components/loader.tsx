import { useEffect } from "react";
import { useWorkspaceParams } from "@/hooks/use-workspace-params";
import {
  getOrCreateWorkspaceCollections,
  refreshDirectoryMetadata,
} from "@/entities/files";

export function Loader({ children }: { children: React.ReactNode }) {
  const { workspacePath } = useWorkspaceParams();

  useEffect(() => {
    if (!workspacePath) {
      return;
    }

    getOrCreateWorkspaceCollections(workspacePath);
    refreshDirectoryMetadata(workspacePath);
  }, [workspacePath]);

  if (!workspacePath) {
    return null;
  }

  // Render children immediately - collections are created synchronously
  // Data will load in the background and components will reactively update
  return <>{children}</>;
}
