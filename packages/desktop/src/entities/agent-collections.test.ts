import { beforeEach, describe, expect, it } from "vitest";
import {
  BasicIndex,
  CollectionConfigurationError,
  createCollection,
  localOnlyCollectionOptions,
} from "@tanstack/react-db";

// A fresh store over its own in-memory database. Turns and entries are
// local-only, so this stays focused on the collection-maintained taskId
// indexes that the service's maintenance passes (replay purge,
// lingering-tool resolution) depend on — not on persistence.
import type {
  AgentEntry,
  AgentStore,
  AgentTurn,
} from "@/agent/agent-collections";
import { testAgentStore } from "@/testing/test-agents";

function turn(
  overrides: Partial<AgentTurn> & Pick<AgentTurn, "turnId" | "taskId">,
): AgentTurn {
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

// A store per test, so index state can't bleed across cases.
let store: AgentStore;
beforeEach(() => {
  store = testAgentStore();
});

describe("agent-collections taskId index derivation", () => {
  it("returns only the requested task's turns and entries across a multi-task workspace", () => {
    // Two tasks interleaved — the real regression this guards against is an
    // index that leaks another task's rows (parallelism is structural here).
    store.turns.insert(turn({ turnId: "trn_a1", taskId: "task_a" }));
    store.turns.insert(turn({ turnId: "trn_b1", taskId: "task_b" }));
    store.turns.insert(turn({ turnId: "trn_a2", taskId: "task_a" }));

    store.entries.insert(
      entry({ id: "evt_a1", taskId: "task_a", turnId: "trn_a1" }),
    );
    store.entries.insert(
      entry({ id: "evt_b1", taskId: "task_b", turnId: "trn_b1" }),
    );
    store.entries.insert(
      entry({ id: "evt_a2", taskId: "task_a", turnId: "trn_a2" }),
    );

    const turnsA = store.turnsForTask("task_a")
      .map((t) => t.turnId)
      .sort();
    expect(turnsA).toEqual(["trn_a1", "trn_a2"]);
    expect(store.turnsForTask("task_b").map((t) => t.turnId)).toEqual([
      "trn_b1",
    ]);

    const entriesA = store.entriesForTask("task_a")
      .map((e) => e.id)
      .sort();
    expect(entriesA).toEqual(["evt_a1", "evt_a2"]);
    expect(store.entriesForTask("task_b").map((e) => e.id)).toEqual(["evt_b1"]);
  });

  it("reflects deletions — a purged turn drops out of its task's lookup", () => {
    store.turns.insert(turn({ turnId: "trn_1", taskId: "task_x" }));
    store.turns.insert(turn({ turnId: "trn_2", taskId: "task_x" }));
    expect(store.turnsForTask("task_x")).toHaveLength(2);

    store.turns.delete("trn_1");

    expect(store.turnsForTask("task_x").map((t) => t.turnId)).toEqual(["trn_2"]);
  });

  it("returns an empty array for a task with no rows", () => {
    expect(store.turnsForTask("task_none")).toEqual([]);
    expect(store.entriesForTask("task_none")).toEqual([]);
  });
});

/**
 * Pins the @tanstack/db 0.6 indexing contract, because it is easy to get
 * wrong from the changelog alone: there is no `@tanstack/db/indexing`
 * subpath (index types are root exports, re-exported by react-db), and
 * `autoIndex` defaults to "off" — the 0.6 break is that an explicit
 * "eager" now throws without `defaultIndexType`, not that the default
 * flipped. If a future release flips it, this fails at bump time rather
 * than as a silent full-scan in the transcript panel.
 */
describe("@tanstack/db 0.6 indexing contract", () => {
  it("re-exports index types from the package root, not an /indexing subpath", () => {
    expect(BasicIndex).toBeTypeOf("function");
  });

  it("defaults autoIndex to off — no index is created without an explicit one", () => {
    const collection = createCollection(
      localOnlyCollectionOptions({
        id: "autoindex-default-probe",
        getKey: (row: { id: string; taskId: string }) => row.id,
      }),
    );
    collection.insert({ id: "r1", taskId: "task_a" });

    expect(collection.config.autoIndex).toBe("off");
    expect([...collection.indexes.values()]).toHaveLength(0);
  });

  it("throws when autoIndex is 'eager' without a defaultIndexType", () => {
    expect(() =>
      createCollection(
        localOnlyCollectionOptions({
          id: "autoindex-eager-probe",
          getKey: (row: { id: string }) => row.id,
          autoIndex: "eager",
        }),
      ),
    ).toThrow(CollectionConfigurationError);
  });

  it("supports an explicit indexType whose equalityLookup returns only matching keys", () => {
    // Mirrors agent-collections.ts's entriesByTask/turnsByTask construction.
    const collection = createCollection(
      localOnlyCollectionOptions({
        id: "explicit-indextype-probe",
        getKey: (row: { id: string; taskId: string }) => row.id,
      }),
    );
    const byTask = collection.createIndex((row) => row.taskId, {
      indexType: BasicIndex,
    });

    collection.insert({ id: "r1", taskId: "task_a" });
    collection.insert({ id: "r2", taskId: "task_b" });
    collection.insert({ id: "r3", taskId: "task_a" });

    expect([...byTask.equalityLookup("task_a")].map(String).sort()).toEqual([
      "r1",
      "r3",
    ]);
    expect([...byTask.equalityLookup("task_b")].map(String)).toEqual(["r2"]);
    expect([...byTask.equalityLookup("task_missing")]).toEqual([]);
  });
});
