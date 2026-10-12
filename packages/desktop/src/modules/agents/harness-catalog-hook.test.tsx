import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import { CoreProvider } from "@notefig/core/react";
import type { Core } from "@notefig/core";
import { createTestCore } from "@/testing/test-core";
import { harnessesModule } from "@/modules/agents/harnesses";
import { useHarnessCatalog } from "@/modules/agents/react";
import { BUILT_IN_HARNESSES } from "@notefig/shared/agent";

let container: HTMLDivElement;
let root: Root;
// The module as booted, so its catalog comes from what sessions announce.
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
    modules: [harnessesModule],
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
  it("shows what sessions announced for that harness, and only it", async () => {
    const read = await renderHook(() => useHarnessCatalog("claude-code"));
    expect(read()).toMatchObject({ commands: null, configOptions: null });
    const harness = (id: string) => BUILT_IN_HARNESSES.find((h) => h.id === id)!;
    const model = (current: string) => [
      {
        id: "model",
        name: "Model",
        category: "model" as const,
        type: "select" as const,
        currentValue: current,
        options: [{ value: current, name: current }],
      },
    ];

    await act(async () => {
      core.hooks.emit("agent:catalog", {
        taskId: "task_1",
        harnessId: "opencode",
        harness: harness("opencode"),
        workspacePath: "/ws",
        configOptions: model("gpt"),
      });
      core.hooks.emit("agent:catalog", {
        taskId: "task_2",
        harnessId: "claude-code",
        harness: harness("claude-code"),
        workspacePath: "/ws",
        configOptions: model("opus"),
      });
      await vi.waitFor(() =>
        expect(core.use("harnesses").collection.get("claude-code")?.catalog).toBeDefined(),
      );
    });

    expect(read().configOptions).toEqual(model("opus"));
    expect(read().loading).toBe(false);
  });
});
