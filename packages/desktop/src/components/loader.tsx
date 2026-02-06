import { useEffect } from "react";
import { useWorkspaceParams } from "@/hooks/use-workspace-params";
import { getOrCreateStore } from "../utils/tinybase";

export function Loader({ children }: { children: React.ReactNode }) {
  const { workspacePath } = useWorkspaceParams();

  useEffect(() => {
    // Early return if no workspace path
    if (!workspacePath) {
      return;
    }

    // Create/get store synchronously
    // This ensures the store exists before children render
    getOrCreateStore(workspacePath);
  }, [workspacePath]);

  // Don't render children if no workspace path
  if (!workspacePath) {
    return null;
  }

  // Render children immediately - store is created synchronously
  // Data will load in the background and components will reactively update
  return <>{children}</>;
}
