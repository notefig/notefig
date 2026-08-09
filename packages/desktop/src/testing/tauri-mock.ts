/**
 * Shared Tauri IPC mock for frontend tests (MET-73).
 *
 * Every test that touches `invoke()` or `listen()` mocks the boundary the same
 * way through here, instead of hand-rolling `vi.mock("@tauri-apps/api/core")`
 * per file. It wraps `@tauri-apps/api/mocks#mockIPC` so tests describe the Rust
 * side as a plain `{ commandName: (payload) => response }` map and get:
 *
 *   - **Command dispatch** on the v2 `(cmd, payload)` signature (payload is the
 *     second argument, NOT a `cmd` field inside it). An unmatched command
 *     rejects with a clear error rather than hanging or silently resolving.
 *   - **Event passthrough.** In Tauri v2 `listen()` itself rides IPC as
 *     `plugin:event|listen`, and every in-scope transport registers listeners
 *     *before* its first real `invoke`. The mock captures those handlers and
 *     exposes an `emit(event, payload)` hook so a test can push a stdout / exit
 *     / fs-change event into the module's registered callbacks — without which
 *     every happy-path test would stall at the listen step.
 *   - **Auto-reset** via `clearMocks()` in `afterEach`, so a mock from one test
 *     never leaks into the next.
 */
import { mockIPC, mockWindows, clearMocks } from "@tauri-apps/api/mocks";
import { afterEach } from "vitest";

/**
 * The Tauri commands this app registers (see `main.rs` `generate_handler!`).
 * Handler maps are open (`Record<string, …>`) so a test only stubs what its
 * module calls — this list is the reference of valid names, not a requirement
 * to stub them all.
 */
export const TAURI_COMMANDS = [
  // agent_proc
  "spawn_agent",
  "write_agent_stdin",
  "kill_agent",
  "run_shell_command",
  // mcp_bridge
  "start_mcp_relay",
  "stop_mcp_relay",
  "write_mcp_line",
  // file_watcher
  "start_watching_metadata",
  "start_watching_content",
  "stop_watching",
  // search
  "search_content",
  // db_ops
  "db_execute",
  "db_query",
  "db_close",
  "db_reset",
] as const;

export type CommandHandler = (
  payload: Record<string, unknown>,
) => unknown | Promise<unknown>;

export type CommandHandlers = Record<string, CommandHandler>;

export interface MockedTauri {
  /**
   * Push an event into every `listen()` callback registered for `event`.
   * Mirrors the Rust side emitting `agent-proc://…/exit`, `fs-metadata-changed`,
   * etc. No-op if nothing is listening for that event yet.
   */
  emit(event: string, payload?: unknown): void;
  /** Every command invocation seen, in order (excludes event-plugin traffic). */
  readonly invocations: ReadonlyArray<{
    cmd: string;
    payload: Record<string, unknown>;
  }>;
  /** Payloads for one command, in call order — convenience for assertions. */
  calls(cmd: string): Array<Record<string, unknown>>;
}

/** Minimal view of the internals `mockIPC` installs on `window`. */
interface TauriInternals {
  runCallback?: (id: number, data: unknown) => void;
}
function internals(): TauriInternals {
  return (window as unknown as { __TAURI_INTERNALS__?: TauriInternals })
    .__TAURI_INTERNALS__!;
}

/**
 * Install a Tauri IPC mock for the current test. Registers an `afterEach` that
 * calls `clearMocks()`.
 *
 * @param handlers  command name → handler returning the (serialized) response
 */
export function withMockedTauri(handlers: CommandHandlers = {}): MockedTauri {
  // event name → set of listener callback ids (from `transformCallback`).
  const listeners = new Map<string, Set<number>>();
  const invocations: Array<{ cmd: string; payload: Record<string, unknown> }> =
    [];

  mockIPC((cmd, payload) => {
    const args = (payload ?? {}) as Record<string, unknown>;

    // `listen()` rides IPC as plugin:event|listen; capture the handler id so
    // emit() can fire it. Return the id as the eventId (what unlisten passes
    // back), matching the real event plugin.
    if (cmd === "plugin:event|listen") {
      const event = args.event as string;
      const handler = args.handler as number;
      let ids = listeners.get(event);
      if (!ids) listeners.set(event, (ids = new Set()));
      ids.add(handler);
      return handler;
    }
    if (cmd === "plugin:event|unlisten") {
      const event = args.event as string;
      const eventId = args.eventId as number;
      listeners.get(event)?.delete(eventId);
      return;
    }
    // Any other event-plugin traffic (emit/emit_to from app code) is a no-op
    // in tests — swallow it rather than routing to the command handler map.
    if (cmd.startsWith("plugin:event|")) return;

    invocations.push({ cmd, payload: args });
    const handler = handlers[cmd];
    if (!handler) {
      // Fail loud: an unstubbed command is a test bug, not a hang.
      throw new Error(
        `[tauri-mock] no handler registered for command "${cmd}"`,
      );
    }
    return handler(args);
  });

  afterEach(() => clearMocks());

  return {
    emit(event, payload) {
      const ids = listeners.get(event);
      if (!ids) return;
      const run = internals().runCallback;
      // Snapshot: a listener may unlisten from inside its own callback.
      for (const id of [...ids]) {
        run?.(id, { event, id, payload });
      }
    },
    invocations,
    calls(cmd) {
      return invocations
        .filter((entry) => entry.cmd === cmd)
        .map((entry) => entry.payload);
    },
  };
}

/**
 * Mock the presence of a window/webview label — needed by modules that call
 * `getCurrentWindow()` / `getCurrentWebview()` during construction (e.g.
 * `TauriAdapter`). Call before importing those modules' window-dependent paths.
 */
export function withMockedWindow(label = "main"): void {
  mockWindows(label);
}
