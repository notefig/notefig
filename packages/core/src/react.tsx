import {
  createContext,
  useCallback,
  useContext,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { Core } from "./create-core";
import type {
  CoreModules,
  WorkspaceModuleName,
  WorkspaceModules,
} from "./types";

const CoreContext = createContext<Core | null>(null);

export function CoreProvider({
  core,
  children,
}: {
  core: Core;
  children: ReactNode;
}) {
  return <CoreContext.Provider value={core}>{children}</CoreContext.Provider>;
}

export function useCore(): Core {
  const core = useContext(CoreContext);
  if (!core) throw new Error("useCore() needs a <CoreProvider> above it.");
  return core;
}

/** A module's API. Stable for the life of the core. */
export function useModule<K extends keyof CoreModules & string>(
  name: K,
): CoreModules[K] {
  return useCore().use(name as never) as CoreModules[K];
}

/**
 * A module's instance for one workspace, or undefined while that workspace
 * is not open. Re-renders when the workspace opens or closes.
 */
export function useWorkspaceModule<K extends WorkspaceModuleName>(
  workspacePath: string | null | undefined,
  name: K,
): WorkspaceModules[K] | undefined {
  const core = useCore();
  const read = useCallback(
    () =>
      workspacePath
        ? (core.workspace(workspacePath)?.[name] as
            WorkspaceModules[K] | undefined)
        : undefined,
    [core, workspacePath, name],
  );
  return useSyncExternalStore(core.workspaces.subscribe, read, read);
}
