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
  /**
   * Open (or focus) an agent session's chat tab. Always a new tab — a
   * session never replaces the file tab in view.
   */
  openAgentTab: (taskId: string) => void;
}

const WorkspaceTabsContext = createContext<
  WorkspaceTabsContextValue | undefined
>(undefined);

const noopOpenAgentTab = () => {};

export function WorkspaceTabsProvider({
  openFile,
  // Optional: hosts without a dockable layout (the editor test harness)
  // have nowhere to open a chat tab. Consumers still get a callable.
  openAgentTab = noopOpenAgentTab,
  children,
}: Omit<WorkspaceTabsContextValue, "openAgentTab"> &
  Partial<Pick<WorkspaceTabsContextValue, "openAgentTab">> & {
    children: ReactNode;
  }) {
  const value = useMemo(
    () => ({ openFile, openAgentTab }),
    [openFile, openAgentTab],
  );

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

/** For components that render both inside and outside a workspace (the
 * settings modal): undefined when no tab surface exists. */
export function useWorkspaceTabsOptional():
  | WorkspaceTabsContextValue
  | undefined {
  return useContext(WorkspaceTabsContext);
}
