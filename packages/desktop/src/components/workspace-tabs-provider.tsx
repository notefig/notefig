import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  type ReactNode,
} from "react";
import type { OpenFileInLayoutOptions } from "@/utils/dockable-layout";
import { registerProtocolContext } from "@/utils/drag-protocol";

interface WorkspaceTabsContextValue {
  /**
   * Open a file as a tab in the workspace layout (selects the existing tab
   * if already open). Returns false when the file type can't be opened in
   * an editor tab.
   */
  openFile: (options: OpenFileInLayoutOptions) => boolean;
}

const WorkspaceTabsContext = createContext<
  WorkspaceTabsContextValue | undefined
>(undefined);

export function WorkspaceTabsProvider({
  openFile,
  children,
}: WorkspaceTabsContextValue & { children: ReactNode }) {
  const value = useMemo(() => ({ openFile }), [openFile]);

  // Drop actions (drag protocol) open files through the same entry point.
  useEffect(() => {
    registerProtocolContext({ openFile });
  }, [openFile]);

  return (
    <WorkspaceTabsContext.Provider value={value}>
      {children}
    </WorkspaceTabsContext.Provider>
  );
}

export function useWorkspaceTabs(): WorkspaceTabsContextValue {
  const context = useContext(WorkspaceTabsContext);
  if (!context) {
    throw new Error(
      "useWorkspaceTabs must be used within a WorkspaceTabsProvider",
    );
  }
  return context;
}
