import { describe, expect, it, vi } from "vitest";
import { createCore } from "./create-core";
import { defineModule } from "./define-module";
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
    const core = createCore({
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
      expect(core.workspace("/ws")?.["t-tasks"]).toBeDefined();
      await Promise.resolve();
      log.push("closing");
    });

    await core.workspaces.open("/ws");
    expect(core.workspace("/ws")?.["t-tasks"].history.log).toBe(log);

    await core.workspaces.close("/ws");
    expect(log).toEqual([
      "create history /ws",
      "create tasks",
      "opened /ws",
      "closing",
      "dispose tasks",
      "dispose history",
    ]);
    expect(core.workspace("/ws")).toBeUndefined();
  });

  it("collapses spellings through workspaceKey and keeps open idempotent", async () => {
    const log: string[] = [];
    const core = createCore({
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
    const core = createCore({ services: {}, modules: [history(log)] });
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
    const core = createCore({
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

  it("closes open workspaces on dispose", async () => {
    const log: string[] = [];
    const core = createCore({ services: {}, modules: [history(log)] });
    core.boot();
    await core.workspaces.open("/a");
    await core.dispose();
    expect(log).toEqual(["create history /a", "dispose history"]);
    expect(core.workspaces.list()).toEqual([]);
  });
});
