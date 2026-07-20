import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The tasks collection's queryFn reaches @/adapters (getAllKv) and the task
// registry; turns/entries are local-only and touch neither. A stub adapter
// keeps this focused on the collection-maintained taskId indexes that the
// service's maintenance passes (replay purge, lingering-tool resolution)
// depend on — not on persistence.
vi.mock("@/adapters", () => ({ platformAdapter: { getAllKv: vi.fn() } }));

import {
  agentEntriesCollection,
  agentTurnsCollection,
  agentEntriesForTask,
  agentTurnsForTask,
  type AgentEntry,
  type AgentTurn,
} from "@/agent/agent-collections";

function turn(overrides: Partial<AgentTurn> & Pick<AgentTurn, "turnId" | "taskId">): AgentTurn {
  return {
    sessionId: "sess_1",
    status: "running",
    startedAt: 0,
    ...overrides,
  };
}

function entry(
  overrides: Partial<AgentEntry> & Pick<AgentEntry, "id" | "taskId" | "turnId">,
): AgentEntry {
  return {
    type: "assistant",
    createdAt: 0,
    ...overrides,
  };
}

// These collections are module singletons; wipe every row between tests so
// index state can't bleed across cases.
function clearCollections() {
  for (const row of [...agentTurnsCollection.toArray]) {
    agentTurnsCollection.delete(row.turnId);
  }
  for (const row of [...agentEntriesCollection.toArray]) {
    agentEntriesCollection.delete(row.id);
  }
}

beforeEach(() => clearCollections());
afterEach(() => clearCollections());

describe("agent-collections taskId index derivation", () => {
  it("returns only the requested task's turns and entries across a multi-task workspace", () => {
    // Two tasks interleaved — the real regression this guards against is an
    // index that leaks another task's rows (parallelism is structural here).
    agentTurnsCollection.insert(turn({ turnId: "trn_a1", taskId: "task_a" }));
    agentTurnsCollection.insert(turn({ turnId: "trn_b1", taskId: "task_b" }));
    agentTurnsCollection.insert(turn({ turnId: "trn_a2", taskId: "task_a" }));

    agentEntriesCollection.insert(entry({ id: "evt_a1", taskId: "task_a", turnId: "trn_a1" }));
    agentEntriesCollection.insert(entry({ id: "evt_b1", taskId: "task_b", turnId: "trn_b1" }));
    agentEntriesCollection.insert(entry({ id: "evt_a2", taskId: "task_a", turnId: "trn_a2" }));

    const turnsA = agentTurnsForTask("task_a").map((t) => t.turnId).sort();
    expect(turnsA).toEqual(["trn_a1", "trn_a2"]);
    expect(agentTurnsForTask("task_b").map((t) => t.turnId)).toEqual(["trn_b1"]);

    const entriesA = agentEntriesForTask("task_a").map((e) => e.id).sort();
    expect(entriesA).toEqual(["evt_a1", "evt_a2"]);
    expect(agentEntriesForTask("task_b").map((e) => e.id)).toEqual(["evt_b1"]);
  });

  it("reflects deletions — a purged turn drops out of its task's lookup", () => {
    agentTurnsCollection.insert(turn({ turnId: "trn_1", taskId: "task_x" }));
    agentTurnsCollection.insert(turn({ turnId: "trn_2", taskId: "task_x" }));
    expect(agentTurnsForTask("task_x")).toHaveLength(2);

    agentTurnsCollection.delete("trn_1");

    expect(agentTurnsForTask("task_x").map((t) => t.turnId)).toEqual(["trn_2"]);
  });

  it("returns an empty array for a task with no rows", () => {
    expect(agentTurnsForTask("task_none")).toEqual([]);
    expect(agentEntriesForTask("task_none")).toEqual([]);
  });
});
