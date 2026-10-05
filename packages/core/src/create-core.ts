import type {
  AnyModule,
  ModuleContext,
  OpenWorkspaces,
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

/** What a workspace handle does, open or not. */
export interface WorkspaceControls {
  readonly path: string;
  /** Identity: two spellings of one workspace share it. */
  readonly key: string;
  isOpen(): boolean;
  /**
   * Open it if it is not open, then announce the entry: `workspace:focused`
   * and `workspace:entered`, each awaited. Resolves once every handler has
   * run. Calls for one workspace while one is in flight join it. Does
   * nothing if a close supersedes it while it waits. Rejects with a
   * `WorkspaceOpenError`, skipping what follows, when a module failed to
   * create its instance or a handler failed.
   */
  open(): Promise<void>;
  /** Open it if needed and bring it forward: `workspace:focused` only.
   *  Rejects like `open`. */
  focus(): Promise<void>;
  /** Fire `workspace:closing` (awaited), then dispose its instances. */
  close(): Promise<void>;
}

/**
 * A workspace, open or not. Its module instances (`handle.files`) read
 * while it is open — and while it is closing, so `closing` handlers can
 * reach what they tear down. Reading one otherwise throws.
 */
export type WorkspaceHandle = WorkspaceControls & Readonly<WorkspaceModules>;

export class WorkspaceClosedError extends Error {
  override name = "WorkspaceClosedError";
}

/** A handle's `open` or `focus` that did not complete. */
export class WorkspaceOpenError extends Error {
  override name = "WorkspaceOpenError";
  /** What failed: the module's create error, or each failing handler's. */
  readonly failures: unknown[];
  constructor(
    readonly workspacePath: string,
    what: string,
    failure: unknown,
  ) {
    super(`Opening ${workspacePath}: ${what}.`);
    this.failures = Array.isArray(failure) ? failure : [failure];
  }
}

export interface CoreBase {
  /** A service or module API by name. */
  use<K extends ProvidedName>(name: K): Provided[K];
  hooks: Hooks;
  /** Which workspaces are open. Opening goes through a handle. */
  workspaces: OpenWorkspaces;
  /** The handle for a workspace, whether or not it is open. */
  workspace(path: string): WorkspaceHandle;
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
   * Every module's instance, or the failure when one failed to create. A partial
   * set is never published: the ones already built are disposed and the
   * workspace stays closed, so the next `open` retries from scratch.
   */
  const createWorkspace = (
    ref: WorkspaceRef,
  ): OpenWorkspace | { failed: unknown } => {
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
        return { failed: error };
      }
    }
    return entryOf();
  };

  const disposeWorkspace = async (entry: OpenWorkspace) => {
    await hooks.emitSerial("workspace:closing", entry.ref);
    await disposeInstances(entry);
  };

  /**
   * Open a workspace and say how it went: open (now or already), a module
   * failed to create its instance (rolled back), or nothing was done —
   * core is shutting down, or a later call superseded this one.
   */
  const openWorkspace = async (
    path: string,
  ): Promise<
    | { outcome: "open"; entry: OpenWorkspace }
    | { outcome: "failed"; error: unknown }
    | { outcome: "skipped" }
  > => {
    // A core that is shutting down opens nothing: its dispose has already
    // taken the list of workspaces to close.
    if (shuttingDown) return { outcome: "skipped" };
    const key = keyOf(path);
    const ticket = takeTicket(key);
    try {
      // A close or a failed open's rollback still running: let it finish
      // first, so its disposers never tear down the fresh instances.
      let pending = closing.get(key)?.done ?? rollingBack.get(key);
      while (pending) {
        await pending;
        if (shuttingDown || latestCall.get(key) !== ticket) {
          return { outcome: "skipped" };
        }
        pending = closing.get(key)?.done ?? rollingBack.get(key);
      }
      const existing = open.get(key);
      if (existing) return { outcome: "open", entry: existing };
      const created = createWorkspace({ key, path });
      if ("failed" in created) {
        return { outcome: "failed", error: created.failed };
      }
      open.set(key, created);
      notify();
      hooks.emit("workspace:opened", created.ref);
      return { outcome: "open", entry: created };
    } finally {
      settle(key, ticket);
    }
  };

  const workspaces: WorkspaceLifecycle = {
    async open(path) {
      await openWorkspace(path);
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
  // Handles
  // ---------------------------------------------------------------------

  /** Entries through a handle in flight, per workspace: a second call of
   *  the same kind joins the first rather than announcing twice. */
  const entering = new Map<string, Promise<void>>();
  const focusing = new Map<string, Promise<void>>();

  /**
   * Open, then announce, one step after another. A step that failed stops
   * the ones after it and rejects the call: the workspace did not open, or
   * a handler the entry depends on (recording it, landing in it) failed.
   * Every handler of the failing hook still ran.
   */
  const bringForward = async (path: string, entered: boolean) => {
    const opened = await openWorkspace(path);
    if (opened.outcome === "failed") {
      throw new WorkspaceOpenError(path, "it did not open", opened.error);
    }
    // A close superseded the open, or core is shutting down: nothing to
    // announce, and nothing went wrong.
    if (opened.outcome === "skipped") return;
    const { ref } = opened.entry;
    const unfocused = await hooks.emitSerial("workspace:focused", ref);
    if (unfocused.length > 0) {
      throw new WorkspaceOpenError(path, "focusing it failed", unfocused);
    }
    if (!entered) return;
    const unentered = await hooks.emitSerial("workspace:entered", ref);
    if (unentered.length > 0) {
      throw new WorkspaceOpenError(path, "entering it failed", unentered);
    }
  };

  const joined = (
    inFlight: Map<string, Promise<void>>,
    key: string,
    start: () => Promise<void>,
  ): Promise<void> => {
    const running = inFlight.get(key);
    if (running) return running;
    const call = start().finally(() => inFlight.delete(key));
    inFlight.set(key, call);
    return call;
  };

  function handleFor(path: string): WorkspaceHandle {
    const key = keyOf(path);
    const controls: WorkspaceControls = {
      path,
      key,
      isOpen: () => open.has(key),
      open: () => joined(entering, key, () => bringForward(path, true)),
      focus: () => joined(focusing, key, () => bringForward(path, false)),
      close: () => workspaces.close(path),
    };
    for (const module of workspaceModules) {
      Object.defineProperty(controls, module.name, {
        get() {
          const entry = open.get(key) ?? closing.get(key)?.entry;
          if (!entry) {
            throw new WorkspaceClosedError(
              `"${module.name}" of ${path} is read while the workspace is not open.`,
            );
          }
          return entry.instances.get(module.name);
        },
        enumerable: true,
      });
    }
    return controls as WorkspaceHandle;
  }

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
    workspaces: {
      isOpen: workspaces.isOpen,
      list: workspaces.list,
      subscribe: workspaces.subscribe,
    },
    workspace: handleFor,
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
