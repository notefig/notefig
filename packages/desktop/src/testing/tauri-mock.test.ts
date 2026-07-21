import { describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { withMockedTauri } from "./tauri-mock";

describe("withMockedTauri", () => {
  it("dispatches a command by name and returns its response", async () => {
    const tauri = withMockedTauri({
      search_content: (payload) => ({ echoed: payload.query }),
    });

    const result = await invoke("search_content", { query: "needle" });

    expect(result).toEqual({ echoed: "needle" });
    // Records the invocation on the v2 (cmd, payload) signature.
    expect(tauri.calls("search_content")).toEqual([{ query: "needle" }]);
  });

  it("rejects an unregistered command clearly instead of hanging", async () => {
    withMockedTauri({});

    await expect(invoke("spawn_agent", {})).rejects.toThrow(
      /no handler registered for command "spawn_agent"/,
    );
  });

  it("emit() reaches a callback registered via listen()", async () => {
    const tauri = withMockedTauri();
    const received: string[] = [];

    // listen() itself goes over IPC (plugin:event|listen) — proving the mock
    // passes it through rather than dropping it at the command dispatch.
    await listen<string>("agent-proc://p1/stdout-line", (event) => {
      received.push(event.payload);
    });

    tauri.emit("agent-proc://p1/stdout-line", "line one");
    tauri.emit("agent-proc://p1/stdout-line", "line two");
    // Unrelated event must not reach this listener.
    tauri.emit("some-other-event", "ignored");

    expect(received).toEqual(["line one", "line two"]);
  });

  it("stops delivering to a listener after it unlistens", async () => {
    const tauri = withMockedTauri();
    const handler = vi.fn();

    const unlisten = await listen("fs-metadata-changed", handler);
    tauri.emit("fs-metadata-changed", { path: "/a" });
    await unlisten();
    tauri.emit("fs-metadata-changed", { path: "/b" });

    expect(handler).toHaveBeenCalledTimes(1);
  });
});
