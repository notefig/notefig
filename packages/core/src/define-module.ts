import type { Hooks } from "./hooks";
import type {
  CoreModules,
  Disposer,
  Provided,
  ProvidedName,
  WorkspaceModuleName,
  WorkspaceModules,
  WorkspaceRef,
} from "./types";

/** Which workspaces are open. What app code sees as `core.workspaces`. */
export interface OpenWorkspaces {
  isOpen(path: string): boolean;
  list(): WorkspaceRef[];
  /** Called after every open and close; returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
}

/**
 * Open and close a workspace's instances directly — for modules only
 * (`ctx.workspaces`), such as one restoring the workspaces a previous run
 * left open. App code opens a workspace through its handle,
 * `core.workspace(path).open()`, which also announces the entry.
 */
export interface WorkspaceLifecycle extends OpenWorkspaces {
  /**
   * Create every module's workspace instance, in dependency order, then fire
   * `workspace:opened`. Idempotent. Waits out a close of the same workspace
   * that is still running, then opens it fresh.
   */
  open(path: string): Promise<void>;
  /**
   * Fire `workspace:closing` (awaited), then dispose every instance in
   * reverse dependency order. Idempotent; a second call joins the first.
   */
  close(path: string): Promise<void>;
}

export interface ModuleContext<Needs extends ProvidedName> {
  /** A service or another module's API. Only names listed in `needs`. */
  use<K extends Needs>(name: K): Provided[K];
  hooks: Hooks;
  workspaces: WorkspaceLifecycle;
}

export interface WorkspaceContext<
  Needs extends ProvidedName,
  WorkspaceNeeds extends WorkspaceModuleName,
> extends ModuleContext<Needs> {
  workspace: WorkspaceRef;
  /** Another module's instance for this workspace. Only `workspace.needs`. */
  useWorkspace<K extends WorkspaceNeeds>(name: K): WorkspaceModules[K];
}

type ApiOf<Name extends string> = Name extends keyof CoreModules
  ? CoreModules[Name]
  : undefined;

/**
 * A module named in `CoreModules` must build that API; others build none.
 * A module that only boots (no API) is declared as `name: undefined`, which
 * makes it nameable in another module's `needs` without a `register`.
 */
type RegisterPart<
  Name extends string,
  Needs extends ProvidedName,
> = Name extends keyof CoreModules
  ? CoreModules[Name] extends undefined
    ? { register?(ctx: ModuleContext<Needs>): undefined }
    : { register(ctx: ModuleContext<Needs>): CoreModules[Name] }
  : { register?(ctx: ModuleContext<Needs>): undefined };

/** A module named in `WorkspaceModules` must build that per-workspace value. */
type WorkspacePart<
  Name extends string,
  Needs extends ProvidedName,
  WorkspaceNeeds extends WorkspaceModuleName,
> = Name extends keyof WorkspaceModules
  ? {
      workspace: {
        needs?: readonly WorkspaceNeeds[];
        create(
          ctx: WorkspaceContext<Needs, WorkspaceNeeds>,
          api: ApiOf<Name>,
        ): WorkspaceModules[Name];
        dispose?(
          instance: WorkspaceModules[Name],
          workspace: WorkspaceRef,
        ): void | Promise<void>;
      };
    }
  : { workspace?: never };

export type ModuleDefinition<
  Name extends string,
  Needs extends ProvidedName = never,
  WorkspaceNeeds extends WorkspaceModuleName = never,
> = {
  name: Name;
  /** Services and modules this one uses; they register and boot first. */
  needs?: readonly Needs[];
  /**
   * Start subscriptions once every module has registered. Runs in
   * dependency order; synchronous so a root can render right after boot.
   * Returns a disposer, run in reverse order when core shuts down.
   */
  boot?(api: ApiOf<Name>, ctx: ModuleContext<Needs>): void | Disposer;
} & RegisterPart<Name, Needs> &
  WorkspacePart<Name, Needs, WorkspaceNeeds>;

/** The runtime shape the kernel works with, types erased. */
export interface AnyModule {
  name: string;
  needs?: readonly string[];
  register?(ctx: ModuleContext<never>): unknown;
  boot?(api: unknown, ctx: ModuleContext<never>): void | Disposer;
  workspace?: {
    needs?: readonly string[];
    create(ctx: WorkspaceContext<never, never>, api: unknown): unknown;
    dispose?(instance: unknown, workspace: WorkspaceRef): void | Promise<void>;
  };
}

/**
 * Declare a module. An identity function: it exists for inference (the
 * `needs` list types `ctx.use`) and so every module reads the same way.
 */
export function defineModule<
  const Name extends string,
  const Needs extends ProvidedName = never,
  const WorkspaceNeeds extends WorkspaceModuleName = never,
>(definition: ModuleDefinition<Name, Needs, WorkspaceNeeds>): AnyModule {
  return definition as unknown as AnyModule;
}
