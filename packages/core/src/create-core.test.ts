import { describe, expect, it, vi } from "vitest";
import {
  createCore,
  WorkspaceClosedError,
  WorkspaceOpenError,
  type CreateCoreOptions,
} from "./create-core";
import { defineModule, type WorkspaceLifecycle } from "./define-module";
import { CoreConfigError } from "./order";

declare module "./types" {
  interface CoreModules {
    "t-store": { value: number };
    "t-reader": { read(): number };
  }
  interface WorkspaceModules {
    "t-history": { log: string[] };
    "t-tasks": { history: { log: string[] } };
  }
  interface CoreHookMap {
    "t:ping": number;
  }
}

const quiet = () => {};

/**
 * A core whose `workspaces` is the raw lifetime a module gets
 * (`ctx.workspaces`): what the lifetime tests below drive. App code only
 * ever opens through a handle.
 */
function coreWithLifecycle(options: CreateCoreOptions) {
  let lifecycle!: WorkspaceLifecycle;
  const probe = defineModule({
    name: "t-lifecycle",
    register: (ctx) => {
      lifecycle = ctx.workspaces;
      return undefined;
    },
  });
  const core = createCore({ ...options, modules: [...options.modules, probe] });
  return Object.assign(core, { workspaces: lifecycle });
}

describe("createCore", () => {
  it("registers in dependency order and exposes APIs by name and as properties", () => {
    const store = defineModule({
      name: "t-store",
      register: () => ({ value: 42 }),
    });
    const reader = defineModule({
      name: "t-reader",
      needs: ["t-store"],
      register: (ctx) => ({ read: () => ctx.use("t-store").value }),
    });

    // Listed out of order on purpose: core sorts by needs.
    const core = createCore({ services: {}, modules: [reader, store] });

    expect(core.use("t-reader").read()).toBe(42);
    expect(core["t-store"].value).toBe(42);
  });

  it("boots in dependency order and keeps listed order where nothing constrains it", () => {
    const calls: string[] = [];
    const a = defineModule({ name: "a", boot: () => void calls.push("a") });
    const b = defineModule({ name: "b", boot: () => void calls.push("b") });
    const store = defineModule({
      name: "t-store",
      register: () => {
        calls.push("register t-store");
        return { value: 1 };
      },
      boot: () => void calls.push("t-store"),
    });
    const reader = defineModule({
      name: "t-reader",
      needs: ["t-store"],
      register: () => ({ read: () => 0 }),
      boot: () => void calls.push("t-reader"),
    });

    const core = createCore({ services: {}, modules: [a, reader, b, store] });
    expect(calls).toEqual(["register t-store"]);

    core.boot();
    core.boot(); // once per core
    expect(calls).toEqual([
      "register t-store",
      "a",
      "t-store",
      "t-reader",
      "b",
    ]);
  });

  it("types each module against the registries (compile-time)", () => {
    defineModule({
      name: "t-store",
      // @ts-expect-error — must build the API declared in CoreModules
      register: () => ({ value: "not a number" }),
    });
    // @ts-expect-error — a module declared in CoreModules must register it
    defineModule({ name: "t-store" });
    defineModule({
      name: "t-reader",
      register: (ctx) => ({
        // @ts-expect-error — "t-store" is not in needs
        read: () => ctx.use("t-store").value,
      }),
    });
    defineModule({
      name: "t-history",
      // @ts-expect-error — a module declared in WorkspaceModules needs its part
      workspace: undefined,
    });
  });

  it("hands services to modules that list them", () => {
    const reader = defineModule({
      name: "t-reader",
      needs: ["clock" as never],
      register: (ctx) => ({
        read: () => (ctx.use("clock" as never) as () => number)(),
      }),
    });
    const core = createCore({
      services: { clock: () => 7 } as never,
      modules: [reader],
    });
    expect(core["t-reader"].read()).toBe(7);
  });

  it("fails startup on a missing need, a cycle, a duplicate or a reserved name", () => {
    const needsGhost = defineModule({ name: "x", needs: ["ghost" as never] });
    expect(() => createCore({ services: {}, modules: [needsGhost] })).toThrow(
      /"x" needs "ghost"/,
    );

    const p = defineModule({ name: "p", needs: ["q" as never] });
    const q = defineModule({ name: "q", needs: ["p" as never] });
    expect(() => createCore({ services: {}, modules: [p, q] })).toThrow(
      "Modules need each other in a cycle: p → q → p",
    );

    const dup = defineModule({ name: "d" });
    expect(() => createCore({ services: {}, modules: [dup, dup] })).toThrow(
      CoreConfigError,
    );

    const reserved = defineModule({ name: "workspace" });
    expect(() => createCore({ services: {}, modules: [reserved] })).toThrow(
      /reserved/,
    );
  });

  it("refuses a use that the module did not declare", () => {
    const store = defineModule({
      name: "t-store",
      register: () => ({ value: 1 }),
    });
    const sneaky = defineModule({
      name: "t-reader",
      register: (ctx) => {
        (ctx.use as (name: string) => unknown)("t-store");
        return { read: () => 0 };
      },
    });
    expect(() =>
      createCore({ services: {}, modules: [store, sneaky] }),
    ).toThrow(/uses "t-store" without listing it in needs/);
  });

  it("isolates a failing boot and disposes boot work in reverse order", async () => {
    const calls: string[] = [];
    const onError = vi.fn();
    const first = defineModule({
      name: "first",
      boot: () => () => void calls.push("dispose first"),
    });
    const broken = defineModule({
      name: "broken",
      boot: () => {
        throw new Error("boom");
      },
    });
    const last = defineModule({
      name: "last",
      boot: () => () => void calls.push("dispose last"),
    });

    const core = createCore({
      services: {},
      modules: [first, broken, last],
      onError,
    });
    core.boot();
    expect(onError).toHaveBeenCalledWith(expect.any(Error), 'boot of "broken"');

    await core.dispose();
    expect(calls).toEqual(["dispose last", "dispose first"]);
  });

  it("fires typed hooks, reporting a failing handler without starving the rest", async () => {
    const onError = vi.fn();
    const core = createCore({ services: {}, modules: [], onError });
    const seen: number[] = [];
    core.hooks.on("t:ping", () => {
      throw new Error("bad handler");
    });
    const off = core.hooks.on("t:ping", (n) => void seen.push(n));

    core.hooks.emit("t:ping", 1);
    await core.hooks.emitSerial("t:ping", 2);
    off();
    core.hooks.emit("t:ping", 3);

    // The throwing handler is still subscribed for all three.
    expect(seen).toEqual([1, 2]);
    expect(onError).toHaveBeenCalledTimes(3);
  });
});

describe("workspaces", () => {
  const history = (log: string[]) =>
    defineModule({
      name: "t-history",
      workspace: {
        create: (ctx) => {
          log.push(`create history ${ctx.workspace.path}`);
          return { log };
        },
        dispose: () => void log.push("dispose history"),
      },
    });
  const tasks = (log: string[]) =>
    defineModule({
      name: "t-tasks",
      workspace: {
        needs: ["t-history"],
        create: (ctx) => {
          log.push("create tasks");
          return { history: ctx.useWorkspace("t-history") };
        },
        dispose: async () => {
          await Promise.resolve();
          log.push("dispose tasks");
        },
      },
    });

  it("creates instances in need order and disposes them in reverse after the closing hook", async () => {
    const log: string[] = [];
    const core = coreWithLifecycle({
      services: {},
      modules: [tasks(log), history(log)],
      onError: quiet,
    });
    core.hooks.on(
      "workspace:opened",
      (ref) => void log.push(`opened ${ref.path}`),
    );
    core.hooks.on("workspace:closing", async () => {
      // Instances are still reachable while closing.
      expect(core.workspace("/ws")["t-tasks"]).toBeDefined();
      await Promise.resolve();
      log.push("closing");
    });

    await core.workspaces.open("/ws");
    expect(core.workspace("/ws")["t-tasks"].history.log).toBe(log);

    await core.workspaces.close("/ws");
    expect(log).toEqual([
      "create history /ws",
      "create tasks",
      "opened /ws",
      "closing",
      "dispose tasks",
      "dispose history",
    ]);
    expect(core.workspace("/ws").isOpen()).toBe(false);
  });

  it("collapses spellings through workspaceKey and keeps open idempotent", async () => {
    const log: string[] = [];
    const core = coreWithLifecycle({
      services: {},
      modules: [history(log)],
      workspaceKey: (p) => p.toLowerCase(),
    });
    await core.workspaces.open("/WS");
    await core.workspaces.open("/ws");
    expect(log).toEqual(["create history /WS"]);
    expect(core.workspaces.isOpen("/ws")).toBe(true);
    expect(core.workspaces.list()).toEqual([{ key: "/ws", path: "/WS" }]);
  });

  it("waits out a running close before reopening, and joins concurrent closes", async () => {
    const log: string[] = [];
    const core = coreWithLifecycle({ services: {}, modules: [history(log)] });
    let release!: () => void;
    core.hooks.on(
      "workspace:closing",
      () => new Promise<void>((resolve) => (release = resolve)),
    );

    await core.workspaces.open("/ws");
    const closeA = core.workspaces.close("/ws");
    const closeB = core.workspaces.close("/ws");
    const reopen = core.workspaces.open("/ws");
    expect(core.workspaces.isOpen("/ws")).toBe(false);

    release();
    await Promise.all([closeA, closeB, reopen]);
    expect(log).toEqual([
      "create history /ws",
      "dispose history",
      "create history /ws",
    ]);
    expect(core.workspaces.isOpen("/ws")).toBe(true);
  });

  it("refuses a workspace need that is not declared", () => {
    const bad = defineModule({
      name: "t-tasks",
      workspace: {
        create: (ctx) => ({
          history: (ctx.useWorkspace as (n: string) => { log: string[] })(
            "t-history",
          ),
        }),
      },
    });
    const onError = vi.fn();
    const core = coreWithLifecycle({
      services: {},
      modules: [history([]), bad],
      onError,
    });
    void core.workspaces.open("/ws");
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringMatching(/without listing it in workspace.needs/),
      }),
      'workspace create of "t-tasks" for /ws',
    );
  });

  it("never publishes a partial workspace: a failed create rolls back and the next open retries", async () => {
    const log: string[] = [];
    let failTasks = true;
    const flakyTasks = defineModule({
      name: "t-tasks",
      workspace: {
        needs: ["t-history"],
        create: (ctx) => {
          if (failTasks) throw new Error("tasks failed");
          return { history: ctx.useWorkspace("t-history") };
        },
      },
    });
    const onError = vi.fn();
    const opened = vi.fn();
    const core = coreWithLifecycle({
      services: {},
      modules: [history(log), flakyTasks],
      onError,
    });
    core.hooks.on("workspace:opened", opened);

    await core.workspaces.open("/ws");
    await Promise.resolve();
    expect(core.workspaces.isOpen("/ws")).toBe(false);
    expect(core.workspace("/ws").isOpen()).toBe(false);
    expect(opened).not.toHaveBeenCalled();
    expect(log).toEqual(["create history /ws", "dispose history"]);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "tasks failed" }),
      'workspace create of "t-tasks" for /ws',
    );

    failTasks = false;
    await core.workspaces.open("/ws");
    expect(core.workspace("/ws")["t-tasks"].history.log).toBe(log);
    expect(opened).toHaveBeenCalledTimes(1);
  });

  it("a retry waits for the failed open's rollback before creating anything", async () => {
    const log: string[] = [];
    let release!: () => void;
    const slowHistory = defineModule({
      name: "t-history",
      workspace: {
        create: () => {
          log.push("create history");
          return { log };
        },
        dispose: async () => {
          await new Promise<void>((resolve) => (release = resolve));
          log.push("dispose history");
        },
      },
    });
    let failTasks = true;
    const flakyTasks = defineModule({
      name: "t-tasks",
      workspace: {
        needs: ["t-history"],
        create: (ctx) => {
          if (failTasks) throw new Error("tasks failed");
          return { history: ctx.useWorkspace("t-history") };
        },
      },
    });
    const core = coreWithLifecycle({
      services: {},
      modules: [slowHistory, flakyTasks],
      onError: quiet,
    });

    await core.workspaces.open("/ws");
    failTasks = false;
    const retry = core.workspaces.open("/ws");
    await Promise.resolve();
    expect(log).toEqual(["create history"]);

    release();
    await retry;
    expect(log).toEqual([
      "create history",
      "dispose history",
      "create history",
    ]);
    expect(core.workspaces.isOpen("/ws")).toBe(true);
  });

  it("a close issued while an open waits is not undone by that open", async () => {
    const log: string[] = [];
    let release!: () => void;
    const core = coreWithLifecycle({ services: {}, modules: [history(log)] });
    core.hooks.on(
      "workspace:closing",
      () => new Promise<void>((resolve) => (release = resolve)),
    );

    await core.workspaces.open("/ws");
    void core.workspaces.close("/ws");
    // Reopened, then closed again, while the first close is still running.
    const reopen = core.workspaces.open("/ws");
    const closeAgain = core.workspaces.close("/ws");

    release();
    await Promise.all([reopen, closeAgain]);
    expect(core.workspaces.isOpen("/ws")).toBe(false);
    expect(log).toEqual(["create history /ws", "dispose history"]);
  });

  it("opens nothing once shutdown has started", async () => {
    const log: string[] = [];
    const core = coreWithLifecycle({ services: {}, modules: [history(log)] });
    core.boot();
    // An open that lands while shutdown hooks run must not outlive dispose.
    core.hooks.on("core:shutdown", () => core.workspaces.open("/late"));

    await core.dispose();
    await core.workspaces.open("/after");

    expect(core.workspaces.list()).toEqual([]);
    expect(log).toEqual([]);
  });

  it("closes open workspaces on dispose", async () => {
    const log: string[] = [];
    const core = coreWithLifecycle({ services: {}, modules: [history(log)] });
    core.boot();
    await core.workspaces.open("/a");
    await core.dispose();
    expect(log).toEqual(["create history /a", "dispose history"]);
    expect(core.workspaces.list()).toEqual([]);
  });
});

describe("workspace handles", () => {
  const history = (log: string[]) =>
    defineModule({
      name: "t-history",
      workspace: {
        create: () => {
          log.push("create history");
          return { log };
        },
      },
    });

  it("exist for a closed workspace; instances read only while it is open", async () => {
    const core = createCore({ services: {}, modules: [history([])] });
    const ws = core.workspace("/ws");

    expect(ws.isOpen()).toBe(false);
    expect(() => ws["t-history"]).toThrow(WorkspaceClosedError);

    await ws.open();
    expect(ws.isOpen()).toBe(true);
    expect(ws["t-history"].log).toEqual(["create history"]);
    // Any handle for the workspace reads the same instance.
    expect(core.workspace("/ws")["t-history"]).toBe(ws["t-history"]);

    await ws.close();
    expect(() => ws["t-history"]).toThrow(WorkspaceClosedError);
  });

  it("open announces focused then entered, each awaited; focus only focused; a module restore neither", async () => {
    const log: string[] = [];
    const core = coreWithLifecycle({ services: {}, modules: [history(log)] });
    core.hooks.on("workspace:opened", () => void log.push("opened"));
    core.hooks.on("workspace:focused", async () => {
      await Promise.resolve();
      log.push("focused");
    });
    core.hooks.on("workspace:entered", () => void log.push("entered"));

    await core.workspaces.open("/restored");
    await core.workspace("/a").open();
    await core.workspace("/a").focus();

    expect(log).toEqual([
      "create history",
      "opened",
      "create history",
      "opened",
      "focused",
      "entered",
      "focused",
    ]);
  });

  it("joins concurrent opens of one workspace: one entry, one announcement", async () => {
    const entered = vi.fn();
    const core = createCore({ services: {}, modules: [history([])] });
    core.hooks.on("workspace:entered", entered);

    const first = core.workspace("/ws").open();
    const second = core.workspace("/ws").open();
    expect(second).toBe(first);
    await first;

    expect(entered).toHaveBeenCalledTimes(1);
  });

  it("announces nothing when a close supersedes an open still waiting", async () => {
    const entered = vi.fn();
    const core = createCore({ services: {}, modules: [history([])] });
    let release!: () => void;
    core.hooks.on(
      "workspace:closing",
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    core.hooks.on("workspace:entered", entered);

    await core.workspace("/ws").open();
    entered.mockClear();
    const closing = core.workspace("/ws").close();
    const reopen = core.workspace("/ws").open();
    const closeAgain = core.workspace("/ws").close();
    release();
    await Promise.all([closing, reopen, closeAgain]);

    expect(core.workspaces.isOpen("/ws")).toBe(false);
    expect(entered).not.toHaveBeenCalled();
  });

  it("rejects an open whose workspace failed to create, and announces nothing", async () => {
    const failing = defineModule({
      name: "t-history",
      workspace: {
        create: () => {
          throw new Error("history failed");
        },
      },
    });
    const focused = vi.fn();
    const core = createCore({
      services: {},
      modules: [failing],
      onError: quiet,
    });
    core.hooks.on("workspace:focused", focused);

    const opening = core.workspace("/ws").open();

    await expect(opening).rejects.toBeInstanceOf(WorkspaceOpenError);
    await expect(opening).rejects.toMatchObject({
      workspacePath: "/ws",
      failures: [expect.objectContaining({ message: "history failed" })],
    });
    expect(focused).not.toHaveBeenCalled();
    expect(core.workspaces.isOpen("/ws")).toBe(false);
  });

  it("a failed focus handler stops the entry: every focus handler runs, entered does not, open rejects", async () => {
    const core = createCore({
      services: {},
      modules: [history([])],
      onError: quiet,
    });
    const recorded = vi.fn();
    const entered = vi.fn();
    core.hooks.on("workspace:focused", async () => {
      throw new Error("row not saved");
    });
    core.hooks.on("workspace:focused", recorded);
    core.hooks.on("workspace:entered", entered);

    await expect(core.workspace("/ws").open()).rejects.toMatchObject({
      failures: [expect.objectContaining({ message: "row not saved" })],
    });
    expect(recorded).toHaveBeenCalledTimes(1);
    expect(entered).not.toHaveBeenCalled();
    // The workspace did open; only the entry stopped.
    expect(core.workspaces.isOpen("/ws")).toBe(true);
  });
});
