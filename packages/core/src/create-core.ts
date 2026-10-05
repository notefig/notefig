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

  /** Set when shutdown starts; from then on nothing opens. */
  let shuttingDown = false;
  /** Failed opens still disposing what they built; a retry waits them out. */
  const rollingBack = new Map<string, Promise<void>>();
  /**
   * The latest open/close call per workspace. An open that had to wait
   * (for a close or a rollback) gives up if a later call superseded it, so
   * a close issued during the wait is never undone by the open behind it.
   */
  const latestCall = new Map<string, number>();
  let nextCall = 0;
  const takeTicket = (key: string) => {
    const ticket = ++nextCall;
    latestCall.set(key, ticket);
    return ticket;
  };
  /** A call is over: forget its ticket unless a later call replaced it.
   *  Absent and superseded read the same to a waiting open. */
  const settle = (key: string, ticket: number) => {
    if (latestCall.get(key) === ticket) latestCall.delete(key);
  };
  let disposed: Promise<void> | null = null;
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

  /** Dispose an entry's instances in reverse need order. Never throws. */
  const disposeInstances = async (entry: OpenWorkspace) => {
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

  /**
   * Every module's instance, or null when one failed to create. A partial
   * set is never published: the ones already built are disposed and the
   * workspace stays closed, so the next `open` retries from scratch.
   */
  const createWorkspace = (ref: WorkspaceRef): OpenWorkspace | null => {
    const instances = new Map<string, unknown>();
    const entryOf = () => ({
      ref,
      instances,
      view: Object.freeze(
        Object.fromEntries(instances),
      ) as Readonly<WorkspaceModules>,
    });
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
          return instances.get(name) as never;
        },
      } as WorkspaceContext<never, never>;
      try {
        instances.set(module.name, part.create(ctx, apis.get(module.name)));
      } catch (error) {
        onError(error, `workspace create of "${module.name}" for ${ref.path}`);
        const rollback = disposeInstances(entryOf()).finally(() => {
          rollingBack.delete(ref.key);
        });
        rollingBack.set(ref.key, rollback);
        return null;
      }
    }
    return entryOf();
  };

  const disposeWorkspace = async (entry: OpenWorkspace) => {
    await hooks.emitSerial("workspace:closing", entry.ref);
    await disposeInstances(entry);
  };

  const workspaces: WorkspaceLifecycle = {
    async open(path) {
      // A core that is shutting down opens nothing: its dispose has already
      // taken the list of workspaces to close.
      if (shuttingDown) return;
      const key = keyOf(path);
      const ticket = takeTicket(key);
      try {
        // A close or a failed open's rollback still running: let it finish
        // first, so its disposers never tear down the fresh instances.
        let pending = closing.get(key)?.done ?? rollingBack.get(key);
        while (pending) {
          await pending;
          if (shuttingDown || latestCall.get(key) !== ticket) return;
          pending = closing.get(key)?.done ?? rollingBack.get(key);
        }
        if (open.has(key)) return;
        const entry = createWorkspace({ key, path });
        if (!entry) return;
        open.set(key, entry);
        notify();
        hooks.emit("workspace:opened", entry.ref);
      } finally {
        settle(key, ticket);
      }
    },
    close(path) {
      const key = keyOf(path);
      const ticket = takeTicket(key);
      const pending = closing.get(key);
      if (pending) {
        void pending.done.then(() => settle(key, ticket));
        return pending.done;
      }
      const entry = open.get(key);
      if (!entry) {
        settle(key, ticket);
        return Promise.resolve();
      }
      open.delete(key);
      // Registered before teardown starts: `closing` handlers run
      // synchronously from here and must still find the instances.
      let finish!: () => void;
      const done = new Promise<void>((resolve) => (finish = resolve));
      closing.set(key, { entry, done });
      notify();
      void disposeWorkspace(entry).finally(() => {
        closing.delete(key);
        settle(key, ticket);
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
      shuttingDown = true;
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
