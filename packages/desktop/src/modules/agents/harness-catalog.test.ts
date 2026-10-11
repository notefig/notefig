import { describe, it, expect, beforeEach } from "vitest";
import { createHooks, type CoreHookMap, type Hooks } from "@notefig/core";
import type {
  AvailableCommand,
  CustomHarnessEntry,
  SessionConfigSelect,
} from "@notefig/shared/agent";
import { createNodeTestDb, type NodeTestDb } from "@/testing/node-db";
import { testHarnesses } from "@/testing/test-harnesses";
import type { HarnessesApi } from "./harnesses";
import {
  catalogFor,
  createHarnessCatalog,
  definitionFingerprint,
  type HarnessCatalogApi,
} from "./harness-catalog";

const command = (name: string, description = name): AvailableCommand => ({
  name,
  description,
});

const models = (current: string): SessionConfigSelect[] => [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: current,
    options: [
      { value: "opus", name: "Opus" },
      { value: "sonnet", name: "Sonnet" },
    ],
  },
];

const report = (
  offer: Partial<CoreHookMap["agent:catalog"]>,
): CoreHookMap["agent:catalog"] => ({
  taskId: "task_1",
  harnessId: "claude-code",
  workspacePath: "/ws",
  ...offer,
});

describe("harness catalog", () => {
  let db: NodeTestDb;
  let hooks: Hooks;
  let harnesses: HarnessesApi;
  let catalog: HarnessCatalogApi;

  /** A booted catalog over `db`, as the app has it. */
  function boot() {
    const hooks = createHooks();
    const catalog = createHarnessCatalog({
      persistence: db.get(),
      hooks,
      harnesses,
    });
    catalog.track();
    return { hooks, catalog };
  }

  const rowsOf = (harnessId: string) =>
    catalog.collection.toArray.filter((row) => row.harnessId === harnessId);

  beforeEach(() => {
    db = createNodeTestDb();
    harnesses = testHarnesses({ db });
    ({ hooks, catalog } = boot());
  });

  it("keeps a session's commands for its workspace, and app-wide while none are", async () => {
    hooks.emit("agent:catalog", report({ commands: [command("review")] }));
    await catalog.settled();

    const rows = rowsOf("claude-code");
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.catalogId.startsWith("hct_"))).toBe(true);
    expect(rows.every((row) => row.source === "session")).toBe(true);
    expect(catalogFor(rows, "/ws").commands).toEqual([command("review")]);
    expect(catalogFor(rows, null).commands).toEqual([command("review")]);
  });

  it("keeps two workspaces' commands apart", async () => {
    hooks.emit(
      "agent:catalog",
      report({ commands: [command("review"), command("create-ticket")] }),
    );
    hooks.emit(
      "agent:catalog",
      report({ workspacePath: "/other", commands: [command("review"), command("deploy")] }),
    );
    await catalog.settled();

    const rows = rowsOf("claude-code");
    expect(rows).toHaveLength(3);
    const names = (workspacePath: string | null) =>
      catalogFor(rows, workspacePath).commands?.map((c) => c.name).sort();
    expect(names("/ws")).toEqual(["create-ticket", "review"]);
    expect(names("/other")).toEqual(["create-ticket", "deploy", "review"]);
    // App-wide keeps the first list it heard.
    expect(names(null)).toEqual(["create-ticket", "review"]);
  });

  it("replaces a workspace's commands with the latest report", async () => {
    hooks.emit("agent:catalog", report({ commands: [command("old")] }));
    hooks.emit("agent:catalog", report({ commands: [command("new")] }));
    await catalog.settled();

    expect(catalogFor(rowsOf("claude-code"), "/ws").commands).toEqual([
      command("old"),
      command("new"),
    ]);
    expect(
      rowsOf("claude-code").find((row) => row.workspacePath === "/ws")?.commands,
    ).toEqual([command("new")]);
  });

  it("keeps a session's settings app-wide, the latest winning", async () => {
    hooks.emit("agent:catalog", report({ configOptions: models("opus") }));
    hooks.emit(
      "agent:catalog",
      report({ workspacePath: "/other", configOptions: models("sonnet") }),
    );
    await catalog.settled();

    const rows = rowsOf("claude-code");
    expect(rows).toHaveLength(1);
    expect(rows[0].workspacePath).toBeNull();
    expect(rows[0].commands).toBeNull();
    expect(catalogFor(rows, "/ws").configOptions).toEqual(models("sonnet"));
  });

  it("stamps a row with the definition it was reported under", async () => {
    hooks.emit("agent:catalog", report({ configOptions: models("opus") }));
    await catalog.settled();

    const definition = harnesses.harness("claude-code").definition()!;
    expect(rowsOf("claude-code")[0].definitionFingerprint).toBe(
      definitionFingerprint(definition),
    );
  });

  it("keeps nothing for a harness that no longer exists", async () => {
    hooks.emit(
      "agent:catalog",
      report({ harnessId: "custom:gone", commands: [command("x")] }),
    );
    await catalog.settled();
    expect(catalog.collection.toArray).toEqual([]);
  });

  it("keeps a custom entry's report", async () => {
    const entry: CustomHarnessEntry = {
      id: "custom:lab",
      label: "Lab",
      command: "lab-acp",
      args: [],
      env: {},
      mcpRegistrationOverride: "none",
      enabled: true,
    };
    await harnesses.harness("custom:lab").saveCustom(entry);
    hooks.emit(
      "agent:catalog",
      report({ harnessId: "custom:lab", commands: [command("x")] }),
    );
    await catalog.settled();
    expect(catalogFor(rowsOf("custom:lab"), null).commands).toEqual([
      command("x"),
    ]);
  });

  it("keeps its rows across a relaunch", async () => {
    hooks.emit("agent:catalog", report({ configOptions: models("opus") }));
    await catalog.settled();

    harnesses = testHarnesses({ db });
    const relaunched = boot().catalog;
    await relaunched.collection.preload();
    expect(catalogFor(relaunched.collection.toArray, null).configOptions).toEqual(
      models("opus"),
    );
  });
});

describe("definitionFingerprint", () => {
  const base = { command: "claude", args: ["--acp"], env: { A: "1", B: "2" } };

  it("is the same for the same spawn, env order aside", () => {
    expect(definitionFingerprint(base)).toBe(
      definitionFingerprint({ ...base, env: { B: "2", A: "1" } }),
    );
  });

  it("differs for another command, args or env", () => {
    const fingerprint = definitionFingerprint(base);
    expect(definitionFingerprint({ ...base, command: "claude2" })).not.toBe(fingerprint);
    expect(definitionFingerprint({ ...base, args: [] })).not.toBe(fingerprint);
    expect(definitionFingerprint({ ...base, env: { A: "1" } })).not.toBe(fingerprint);
  });
});
