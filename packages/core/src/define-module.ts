import type { Hooks } from "./hooks";
import { CoreConfigError } from "./order";
import type {
  CoreModules,
  CoreServices,
  Disposer,
  Provided,
  ProvidedName,
  WorkspaceHandle,
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
  /**
   * Any workspace's handle, as `core.workspace(path)`: how a module reaches
   * another module's instance for a given workspace (the files of the
   * workspace a tab's path is in). Inside `workspace.create`, the
   * workspace's own instances come from `useWorkspace` instead.
   */
  workspaceHandle(path: string): WorkspaceHandle;
}

export interface WorkspaceContext<
  Needs extends ProvidedName,
  WorkspaceNeeds extends WorkspaceModuleName,
> extends ModuleContext<Needs> {
  workspace: WorkspaceRef;
  /** Another module's instance for this workspace. Only `workspace.needs`. */
  useWorkspace<K extends WorkspaceNeeds>(name: K): WorkspaceModules[K];
}

/** A service, named by the key the root hands it under. */
export type ServiceName = keyof CoreServices & string;

/** The name a needed module provides under. */
type NeedName<N> = N extends Module<infer Name> ? Name : never;

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
  WorkspaceDeps extends readonly Module[],
  WorkspaceNeeds extends WorkspaceModuleName,
> = Name extends keyof WorkspaceModules
  ? {
      workspace: {
        /** The modules whose instance for this workspace this one uses. */
        needs?: WorkspaceDeps;
        create(
          ctx: WorkspaceContext<Needs, WorkspaceNeeds>,
          api: ApiOf<Name>,
        ): WorkspaceModules[Name];
        /** `api` is this module's own, as `create` gets it. */
        dispose?(
          instance: WorkspaceModules[Name],
          workspace: WorkspaceRef,
          api: ApiOf<Name>,
        ): void | Promise<void>;
      };
    }
  : { workspace?: never };

export type ModuleDefinition<
  Name extends string,
  Deps extends readonly Module[] = [],
  WorkspaceDeps extends readonly Module[] = [],
  Needs extends ProvidedName = NeedName<Deps[number]> & ProvidedName,
  WorkspaceNeeds extends WorkspaceModuleName = NeedName<WorkspaceDeps[number]> &
    WorkspaceModuleName,
> = {
  name: Name;
  /**
   * The modules this one uses, services included (`defineService`); they
   * register and boot first. A needed module the root did not list is
   * registered anyway.
   */
  needs?: Deps;
  /**
   * Start subscriptions once every module has registered. Runs in
   * dependency order; synchronous so a root can render right after boot.
   * Returns a disposer, run in reverse order when core shuts down.
   */
  boot?(api: ApiOf<Name>, ctx: ModuleContext<Needs>): void | Disposer;
} & RegisterPart<Name, Needs> &
  WorkspacePart<Name, Needs, WorkspaceDeps, WorkspaceNeeds>;

/** The runtime shape the kernel works with, types erased. */
export interface AnyModule {
  name: string;
  needs?: readonly AnyModule[];
  register?(ctx: ModuleContext<never>): unknown;
  boot?(api: unknown, ctx: ModuleContext<never>): void | Disposer;
  workspace?: {
    needs?: readonly AnyModule[];
    create(ctx: WorkspaceContext<never, never>, api: unknown): unknown;
    dispose?(
      instance: unknown,
      workspace: WorkspaceRef,
      api: unknown,
    ): void | Promise<void>;
  };
}

/** A module as `defineModule` returns it: what a root lists, and what
 *  another module's `needs` names it by. */
export interface Module<Name extends string = string> extends AnyModule {
  readonly name: Name;
}

/**
 * Declare a module. An identity function: it exists for inference (the
 * `needs` list types `ctx.use`) and so every module reads the same way.
 */
export function defineModule<
  const Name extends string,
  const Deps extends readonly Module[] = [],
  const WorkspaceDeps extends readonly Module[] = [],
>(definition: ModuleDefinition<Name, Deps, WorkspaceDeps>): Module<Name> {
  return definition as unknown as Module<Name>;
}

/**
 * A service as a module: what another module lists in `needs` to be handed
 * the value the root provides under this name (`createCore({ services })`).
 * Its type comes from `CoreServices`. Startup fails if a module needs a
 * service the root did not provide.
 */
export function defineService<const Name extends ServiceName>(
  name: Name,
): Module<Name> {
  return {
    name,
    register() {
      throw new CoreConfigError(
        `Service "${name}" is needed but the root did not provide it.`,
      );
    },
  };
}
