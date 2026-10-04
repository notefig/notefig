import type {
  AnyModule,
  ModuleContext,
  WorkspaceContext,
  WorkspaceLifecycle,
} from "./define-module";
import { createHooks, type Hooks } from "./hooks";
import { CoreConfigError, orderModules } from "./order";
import type {
  CoreModules,
  CoreServices,
  Disposer,
  Provided,
  ProvidedName,
  WorkspaceModules,
  WorkspaceRef,
} from "./types";

export interface CreateCoreOptions {
  /** What the host hands every module: the platform adapter, query client… */
  services: CoreServices;
  /** In any order; core sorts them by `needs`. */
  modules: readonly AnyModule[];
  /**
   * Identity of a workspace path. Two spellings of one workspace (Windows
   * case, trailing separators) must map to one key. Defaults to the path.
   */
  workspaceKey?: (path: string) => string;
  /** Where a failing boot, hook handler or dispose is reported. */
  onError?: (error: unknown, where: string) => void;
}

export interface CoreBase {
  /** A service or module API by name. */
  use<K extends ProvidedName>(name: K): Provided[K];
  hooks: Hooks;
  workspaces: WorkspaceLifecycle;
  /**
   * Every module's instance for this workspace, or undefined when it is not
   * open. Still answers while the workspace is closing, so `closing`
   * handlers can reach what they are tearing down.
   */
  workspace(path: string): Readonly<WorkspaceModules> | undefined;
  /** Run every module's `boot`, in dependency order. Once per core. */
  boot(): void;
  /** Close every workspace, then run boot disposers in reverse order. */
  dispose(): Promise<void>;
}

/** Module APIs also read as properties: `core.files`. */
export type Core = CoreBase & Readonly<CoreModules>;

const RESERVED = new Set<string>([
  "use",
  "hooks",
  "workspaces",
  "workspace",
  "boot",
  "dispose",
]);

interface OpenWorkspace {
  ref: WorkspaceRef;
  instances: Map<string, unknown>;
  view: Readonly<WorkspaceModules>;
}

export function createCore(options: CreateCoreOptions): Core {
  const keyOf = options.workspaceKey ?? ((path: string) => path);
  const onError =
    options.onError ??
    ((error: unknown, where: string) =>
      console.error(`[core] ${where} failed:`, error));
  const hooks = createHooks((error, hook) => onError(error, `hook ${hook}`));

  const services = new Map<string, unknown>(
    Object.entries(options.services as object),
  );
  const ordered = orderModules(options.modules, new Set(services.keys()));
  for (const module of ordered) {
    if (RESERVED.has(module.name)) {
      throw new CoreConfigError(
        `Module name "${module.name}" is reserved by core.`,
      );
    }
  }

  const apis = new Map<string, unknown>();

  const provided = (name: string): unknown =>
    services.has(name) ? services.get(name) : apis.get(name);

  // ---------------------------------------------------------------------
  // Workspaces
  // ---------------------------------------------------------------------

  const open = new Map<string, OpenWorkspace>();
  const closing = new Map<
    string,
    { entry: OpenWorkspace; done: Promise<void> }
  >();
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  const workspaceModules = ordered.filter((module) => module.workspace);

  const createWorkspace = (ref: WorkspaceRef): OpenWorkspace => {
    const instances = new Map<string, unknown>();
    for (const module of workspaceModules) {
      const part = module.workspace!;
      const ctx: WorkspaceContext<never, never> = {
        ...contextFor(module),
        workspace: ref,
        useWorkspace(name: string) {
          if (!(part.needs ?? []).includes(name)) {
            throw new CoreConfigError(
              `Module "${module.name}" uses the workspace instance of "${name}" without listing it in workspace.needs.`,
            );
          }
          if (!instances.has(name)) {
            throw new Error(
              `The workspace instance of "${name}" failed to create, so "${module.name}" cannot use it.`,
            );
          }
          return instances.get(name) as never;
        },
      } as WorkspaceContext<never, never>;
      try {
        instances.set(module.name, part.create(ctx, apis.get(module.name)));
      } catch (error) {
        onError(error, `workspace create of "${module.name}" for ${ref.path}`);
      }
    }
    const view = Object.freeze(
      Object.fromEntries(instances),
    ) as Readonly<WorkspaceModules>;
    return { ref, instances, view };
  };

  const disposeWorkspace = async (entry: OpenWorkspace) => {
    await hooks.emitSerial("workspace:closing", entry.ref);
    for (const module of [...workspaceModules].reverse()) {
      if (!entry.instances.has(module.name)) continue;
      try {
        await module.workspace!.dispose?.(
          entry.instances.get(module.name),
          entry.ref,
        );
      } catch (error) {
        onError(
          error,
          `workspace dispose of "${module.name}" for ${entry.ref.path}`,
        );
      }
    }
  };

  const workspaces: WorkspaceLifecycle = {
    async open(path) {
      const key = keyOf(path);
      const pending = closing.get(key);
      if (pending) {
        await pending.done;
        return workspaces.open(path);
      }
      if (open.has(key)) return;
      const entry = createWorkspace({ key, path });
      open.set(key, entry);
      notify();
      hooks.emit("workspace:opened", entry.ref);
    },
    close(path) {
      const key = keyOf(path);
      const pending = closing.get(key);
      if (pending) return pending.done;
      const entry = open.get(key);
      if (!entry) return Promise.resolve();
      open.delete(key);
      // Registered before teardown starts: `closing` handlers run
      // synchronously from here and must still find the instances.
      let finish!: () => void;
      const done = new Promise<void>((resolve) => (finish = resolve));
      closing.set(key, { entry, done });
      notify();
      void disposeWorkspace(entry).finally(() => {
        closing.delete(key);
        notify();
        finish();
      });
      return done;
    },
    isOpen(path) {
      return open.has(keyOf(path));
    },
    list() {
      return [...open.values()].map((entry) => entry.ref);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };

  // ---------------------------------------------------------------------
  // Modules
  // ---------------------------------------------------------------------

  function contextFor(module: AnyModule): ModuleContext<never> {
    const needs = new Set(module.needs ?? []);
    return {
      use(name: string) {
        if (!needs.has(name)) {
          throw new CoreConfigError(
            `Module "${module.name}" uses "${name}" without listing it in needs.`,
          );
        }
        return provided(name) as never;
      },
      hooks,
      workspaces,
    } as ModuleContext<never>;
  }

  // Register phase: build every API, dependencies first. No side effects
  // belong here, so a failure is a programming error and fails startup.
  for (const module of ordered) {
    apis.set(module.name, module.register?.(contextFor(module)));
  }

  const disposers: Disposer[] = [];
  let booted = false;
  let disposed: Promise<void> | null = null;

  const base: CoreBase = {
    use(name) {
      if (!services.has(name) && !apis.has(name)) {
        throw new CoreConfigError(`Nothing named "${name}" is registered.`);
      }
      return provided(name) as never;
    },
    hooks,
    workspaces,
    workspace(path) {
      const key = keyOf(path);
      return (open.get(key) ?? closing.get(key)?.entry)?.view;
    },
    boot() {
      if (booted) return;
      booted = true;
      for (const module of ordered) {
        if (!module.boot) continue;
        try {
          const dispose = module.boot(
            apis.get(module.name),
            contextFor(module),
          );
          if (dispose) disposers.push(dispose);
        } catch (error) {
          // Degrade, don't disappear: one module failing to boot must not
          // take the others (or the first render) down with it.
          onError(error, `boot of "${module.name}"`);
        }
      }
      hooks.emit("core:booted", undefined);
    },
    dispose() {
      disposed ??= (async () => {
        await hooks.emitSerial("core:shutdown", undefined);
        await Promise.all(
          workspaces.list().map((ref) => workspaces.close(ref.path)),
        );
        for (const dispose of disposers.reverse()) {
          try {
            await dispose();
          } catch (error) {
            onError(error, "boot disposer");
          }
        }
      })();
      return disposed;
    },
  };

  const core = base as Core;
  for (const module of ordered) {
    Object.defineProperty(core, module.name, {
      get: () => apis.get(module.name),
      enumerable: true,
    });
  }
  return core;
}
