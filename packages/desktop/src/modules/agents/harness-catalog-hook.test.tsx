import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import { CoreProvider } from "@notefig/core/react";
import type { Core } from "@notefig/core";
import { createTestCore } from "@/testing/test-core";
import { harnessCatalogModule } from "@/modules/agents/harness-catalog";
import { useHarnessCatalog } from "@/modules/agents/react";

let container: HTMLDivElement;
let root: Root;
// The module as booted, so its rows come from what sessions announce.
let core: Core;

function Probe<T>({ use, onValue }: { use: () => T; onValue: (v: T) => void }) {
  const value = use();
  useEffect(() => {
    onValue(value);
  });
  return null;
}

async function renderHook<T>(use: () => T): Promise<() => T> {
  let latest: T | undefined;
  await act(async () => {
    root.render(
      createElement(CoreProvider, {
        core,
        children: createElement(Probe<T>, {
          use,
          onValue: (value: T) => {
            latest = value;
          },
        }),
      }),
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return () => latest as T;
}

beforeEach(async () => {
  core = createTestCore({
    modules: [harnessCatalogModule],
    platform: {
      proc: {
        runShellCommand: () => Promise.reject(new Error("no shell here")),
      } as never,
    },
  });
  await core.boot();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("useHarnessCatalog", () => {
  it("shows what a session announced, the workspace's commands over the app-wide ones", async () => {
    const read = await renderHook(() => useHarnessCatalog("claude-code", "/ws"));
    expect(read()).toMatchObject({ commands: null, configOptions: null });

    await act(async () => {
      core.hooks.emit("agent:catalog", {
        taskId: "task_1",
        harnessId: "claude-code",
        workspacePath: "/other",
        commands: [{ name: "review", description: "app-wide" }],
      });
      core.hooks.emit("agent:catalog", {
        taskId: "task_2",
        harnessId: "claude-code",
        workspacePath: "/ws",
        commands: [{ name: "review", description: "here" }, { name: "skill", description: "s" }],
      });
      await core.use("harnessCatalog").settled();
    });

    expect(read().commands).toEqual([
      { name: "review", description: "here" },
      { name: "skill", description: "s" },
    ]);
    expect(read().loading).toBe(false);
  });
});
