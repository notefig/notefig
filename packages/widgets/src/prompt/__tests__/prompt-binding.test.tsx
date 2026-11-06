/**
 * The widget's binding to its session (usePromptBinding): an unbind cancels
 * an adoption of the session it unbinds still waiting on its answer, and
 * only that one.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { usePromptBinding } from "../node-view";
import type { PromptWidgetsApi } from "../widgets-service";
import { fakePromptWidgetHost } from "../../testing/fake-host";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const BLOB = "blob_1";

/** A prompt service holding one widget whose binding the test sets. */
function fakePrompts(bound: string | null) {
  const listeners = new Set<() => void>();
  const prompts = {
    get: () => ({ boundTaskId: bound }),
    subscribe: (_blobId: string, listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setDocument: vi.fn(),
    restore: vi.fn(),
  };
  const setBound = (next: string | null) => {
    bound = next;
    for (const listener of listeners) listener();
  };
  return { prompts: prompts as unknown as PromptWidgetsApi, restore: prompts.restore, setBound };
}

/** Reachability answers the test releases by hand. */
function heldReachability() {
  const answers = new Map<string, (reachable: boolean) => void>();
  const host = fakePromptWidgetHost({
    isTaskReachable: vi.fn(
      (taskId: string) => new Promise<boolean>((resolve) => answers.set(taskId, resolve)),
    ),
  });
  const answer = async (taskId: string) => {
    await act(async () => answers.get(taskId)!(true));
  };
  return { host, answer };
}

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
});

function mountBinding(props: Omit<Parameters<typeof usePromptBinding>[0], "filePath" | "blobId" | "writeTaskId">) {
  const Binding = (p: typeof props) => {
    usePromptBinding({ ...p, filePath: "/ws/doc.md", blobId: BLOB, writeTaskId: () => {} });
    return null;
  };
  root = createRoot(document.createElement("div"));
  act(() => root!.render(createElement(Binding, props)));
  return (next: typeof props) => act(() => root!.render(createElement(Binding, next)));
}

describe("usePromptBinding", () => {
  it("an unbind cancels the pending adoption of the session it unbinds", async () => {
    const { prompts, restore, setBound } = fakePrompts("task_a");
    const { host, answer } = heldReachability();
    mountBinding({ prompts, host, persistedTaskId: "task_a" });

    act(() => setBound(null));
    await answer("task_a");

    expect(restore).not.toHaveBeenCalled();
  });

  it("an unbind leaves the adoption of another session, rewritten into the marker, alone", async () => {
    const { prompts, restore, setBound } = fakePrompts("task_a");
    const { host, answer } = heldReachability();
    const rerender = mountBinding({ prompts, host, persistedTaskId: "task_a" });

    // In one commit: the marker now names task_b, and task_a unbinds.
    act(() => {
      setBound(null);
      rerender({ prompts, host, persistedTaskId: "task_b" });
    });
    await answer("task_b");

    expect(restore).toHaveBeenCalledWith(BLOB, "task_b");
  });
});
