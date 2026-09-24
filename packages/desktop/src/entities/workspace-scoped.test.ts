/**
 * The per-workspace lifetime idiom. Mirrors workspace-watchers.test.ts: the
 * open set is the only input, and the subscription is started and stopped
 * per test so module-scope state never leaks between cases.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/adapters", async () => ({
  platformAdapter: {
    db: (await import("@/testing/node-db")).createNodeTestDb(),
  },
}));

import { openWorkspacesCollection } from "@/entities/open-workspaces";
import {
  startWorkspaceScopeSubscription,
  workspaceScoped,
} from "./workspace-scoped";

function row(key: string) {
  return { key, path: key, openedAt: 1, focusedAt: 1 };
}

let stopSubscription: (() => void) | undefined;

beforeEach(() => {
  for (const existing of [...openWorkspacesCollection.values()]) {
    openWorkspacesCollection.delete(existing.key);
  }
});

afterEach(() => {
  stopSubscription?.();
  stopSubscription = undefined;
});

function scope() {
  const created: string[] = [];
  const disposed: string[] = [];
  const s = workspaceScoped({
    create: (native) => {
      created.push(native);
      return { native };
    },
    dispose: (value) => disposed.push(value.native),
  });
  return { s, created, disposed };
}

describe("workspaceScoped", () => {
  it("creates once per workspace on first read and returns the same value after", () => {
    const { s, created } = scope();

    const a = s.get("/ws");
    const b = s.get("/ws");

    expect(a).toBe(b);
    expect(created).toEqual(["/ws"]);
  });

  it("disposes the value when the workspace leaves the open set", () => {
    stopSubscription = startWorkspaceScopeSubscription();
    openWorkspacesCollection.insert(row("/ws"));
    const { s, disposed } = scope();
    s.get("/ws");

    openWorkspacesCollection.delete("/ws");

    expect(disposed).toEqual(["/ws"]);
    expect(s.peek("/ws")).toBeUndefined();
  });

  it("refuses to create for a workspace that is not open while the subscription is live", () => {
    // The resurrection bug: a lazy read after close used to recreate the
    // git collection with nothing left to dispose it.
    stopSubscription = startWorkspaceScopeSubscription();
    const { s, created } = scope();

    expect(s.get("/never-opened")).toBeUndefined();
    expect(created).toEqual([]);
  });

  it("getOrCreate creates regardless, and the row's delete still disposes it", () => {
    stopSubscription = startWorkspaceScopeSubscription();
    const { s, disposed } = scope();

    s.getOrCreate("/ws");
    openWorkspacesCollection.insert(row("/ws"));
    openWorkspacesCollection.delete("/ws");

    expect(disposed).toEqual(["/ws"]);
  });

  it("without a live subscription, get creates freely (suites that never boot)", () => {
    const { s } = scope();
    expect(s.get("/ws")).toBeDefined();
  });

  it("does not dispose when the row is updated in place", () => {
    stopSubscription = startWorkspaceScopeSubscription();
    openWorkspacesCollection.insert(row("/ws"));
    const { s, disposed } = scope();
    s.get("/ws");

    openWorkspacesCollection.update("/ws", (draft) => {
      draft.focusedAt = 2;
    });

    expect(disposed).toEqual([]);
  });

  it("drop disposes now and the next read recreates", () => {
    stopSubscription = startWorkspaceScopeSubscription();
    openWorkspacesCollection.insert(row("/ws"));
    const { s, created, disposed } = scope();
    const first = s.get("/ws");

    s.drop("/ws");
    const second = s.get("/ws");

    expect(disposed).toEqual(["/ws"]);
    expect(created).toEqual(["/ws", "/ws"]);
    expect(second).not.toBe(first);
  });

  it("keys by workspaceKey but builds from the native spelling", () => {
    const { s, created } = scope();
    const a = s.get("/ws/");
    const b = s.get("/ws");
    expect(a).toBe(b);
    expect(created).toEqual(["/ws"]);
  });

  it("is idempotent: a second start while one is live returns the same disposer", () => {
    stopSubscription = startWorkspaceScopeSubscription();
    const second = startWorkspaceScopeSubscription();
    expect(second).toBe(stopSubscription);
  });

  it("tearing the subscription down drops every scope's values", () => {
    const stop = startWorkspaceScopeSubscription();
    openWorkspacesCollection.insert(row("/ws-a"));
    openWorkspacesCollection.insert(row("/ws-b"));
    const { s, disposed } = scope();
    s.get("/ws-a");
    s.get("/ws-b");

    stop();

    expect(disposed.sort()).toEqual(["/ws-a", "/ws-b"]);
  });
});
