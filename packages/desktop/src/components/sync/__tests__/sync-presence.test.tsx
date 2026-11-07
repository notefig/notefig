import { afterEach, describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { defineModule } from "@notefig/core";
import { CoreProvider } from "@notefig/core/react";
import { createTestCore } from "@/testing/test-core";
import { SyncPresenceCell } from "@/components/sync/sync-presence";
import {
  INITIAL_SYNC_STATE,
  syncCapabilities,
  transition,
  type SyncLease,
  type SyncPeer,
  type WorkspaceSync,
} from "@/modules/sync";
import type { LeaseHolder } from "@/modules/sync/lease-rules";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const WS = "/ws";
let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  document.body.innerHTML = "";
  root = null;
});

const ada: SyncPeer = {
  deviceId: "dev-ada",
  name: "Ada",
  color: "#8e4ec6",
  focused: true,
  cursors: [{ path: "/ws/notes/plan.md", anchor: { blockIndex: 2, offset: 1 } }],
  agents: [
    {
      taskId: "task-1",
      harness: "claude",
      label: "Tighten the intro",
      status: "editing",
      path: "/ws/notes/plan.md",
      anchor: { blockIndex: 0, offset: 1 },
    },
  ],
};

const me: LeaseHolder = { id: "dev-me", kind: "human", deviceId: "dev-me", name: "Me", color: "#e5484d" };

/** A workspace's sync with just what the cell reads. */
function fakeSync(shared: boolean) {
  const listeners = new Set<() => void>();
  let peers: SyncPeer[] = [];
  let leases: SyncLease[] = [];
  let state = transition(INITIAL_SYNC_STATE, { type: "enable" });
  if (shared) state = transition(state, { type: "peers", present: true });
  const capabilities = syncCapabilities(state);
  const sync = {
    workspacePath: WS,
    capabilities: () => capabilities,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    presence: () => peers,
    leases: () => leases,
    identity: () => ({ name: "Me", color: "#e5484d", settings: {} }),
  } as unknown as WorkspaceSync;
  const show = (next: SyncPeer[], nextLeases: SyncLease[] = leases) => {
    peers = next;
    leases = nextLeases;
    listeners.forEach((listener) => listener());
  };
  return { sync, show };
}

async function render(shared: boolean) {
  const fake = fakeSync(shared);
  const core = createTestCore({
    modules: [defineModule({ name: "sync", workspace: { create: () => fake.sync } })],
  });
  await core.boot();
  await core.workspace(WS).open();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root!.render(
      createElement(CoreProvider, {
        core,
        children: createElement(SyncPresenceCell, { workspacePath: WS }),
      }),
    ),
  );
  return fake;
}

const cell = () => document.querySelector<HTMLButtonElement>("[data-testid=sync-presence]");

describe("the presence list", () => {
  it("shows the people here and their agents at the shared level", async () => {
    const fake = await render(true);
    expect(cell()).toBeNull();
    act(() => fake.show([ada]));
    expect(cell()?.getAttribute("aria-label")).toBe("1 person here, 1 agent");
    expect(cell()?.textContent).toContain("A");
    act(() => {
      cell()!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
      cell()!.click();
    });
    const row = document.querySelector("[data-testid=sync-presence-peer]");
    expect(row?.textContent).toContain("Ada");
    expect(row?.textContent).toContain("plan.md");
    const agent = document.querySelector("[data-testid=sync-presence-agent]");
    expect(agent?.textContent).toContain("claude");
    expect(agent?.textContent).toContain("editing plan.md");
    expect(agent?.textContent).toContain("Tighten the intro");
    // No leases: no lock counts.
    expect(document.querySelector("[data-testid=sync-presence-holds]")).toBeNull();
    expect(document.querySelector("[data-testid=sync-presence-held]")).toBeNull();
    // Ada takes 3 blocks, her agent 2 of them; this device holds 1.
    act(() =>
      fake.show(
        [{ ...ada, holds: 3, agents: ada.agents.map((agent) => ({ ...agent, holds: 2 })) }],
        [{ holder: me, path: "/ws/plan.md", blocks: [4], mine: true }],
      ),
    );
    expect(document.querySelector("[data-testid=sync-presence-holds]")?.textContent).toBe(
      "holds 3 blocks",
    );
    expect(document.querySelector("[data-testid=sync-presence-agent-holds]")?.textContent).toBe(
      "holds 2 blocks",
    );
    expect(document.querySelector("[data-testid=sync-presence-mine]")?.textContent).toBe("holds 1 block");
    expect(cell()?.getAttribute("aria-label")).toBe("1 person here, 1 agent, 3 blocks held");
    // Released: the counts go.
    act(() => fake.show([ada], []));
    expect(document.querySelector("[data-testid=sync-presence-holds]")).toBeNull();
    expect(document.querySelector("[data-testid=sync-presence-mine]")).toBeNull();
    expect(document.body.textContent).toContain("You appear as Me");
  });

  it("never shows at solo", async () => {
    const fake = await render(false);
    act(() => fake.show([ada]));
    expect(cell()).toBeNull();
  });
});
