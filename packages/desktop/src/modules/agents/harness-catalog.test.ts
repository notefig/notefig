import { describe, it, expect, beforeEach } from "vitest";
import { createHooks, type CoreHookMap } from "@notefig/core";
import {
  BUILT_IN_HARNESSES,
  type SessionConfigSelect,
} from "@notefig/shared/agent";
import { createNodeTestDb, type NodeTestDb } from "@/testing/node-db";
import { testHarnesses } from "@/testing/test-harnesses";
import type { HarnessesApi } from "./harnesses";
import { definitionFingerprint } from "./harness-catalog";

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

const claude = BUILT_IN_HARNESSES.find((harness) => harness.id === "claude-code")!;

const report = (
  offer: Partial<CoreHookMap["agent:catalog"]>,
): CoreHookMap["agent:catalog"] => ({
  taskId: "task_1",
  harnessId: "claude-code",
  harness: claude,
  workspacePath: "/ws",
  ...offer,
});

describe("a harness's catalog", () => {
  let db: NodeTestDb;
  let harnesses: HarnessesApi;
  const at = 1_000;

  beforeEach(async () => {
    db = createNodeTestDb();
    harnesses = testHarnesses({ db, now: () => at });
    await harnesses.ready();
  });

  const catalogOf = (harnessId: string) =>
    harnesses.collection.get(harnessId)?.catalog;

  it("keeps a session's settings on the harness's row", async () => {
    await harnesses.harness("claude-code").recordOffer(report({ configOptions: models("opus") }));

    expect(catalogOf("claude-code")).toEqual({
      configOptions: models("opus"),
      commands: null,
      source: "session",
      fetchedAt: at,
      definitionFingerprint: definitionFingerprint(claude),
    });
  });

  it("keeps no session's commands: they may be its workspace's own skills", async () => {
    await harnesses.harness("claude-code").recordOffer({
      ...report({ configOptions: models("opus") }),
      commands: [{ name: "create-ticket", description: "a project skill" }],
    } as CoreHookMap["agent:catalog"]);
    await harnesses.harness("opencode").recordOffer(
      report({
        harnessId: "opencode",
        commands: [{ name: "deploy", description: "" }],
      }),
    );

    expect(catalogOf("claude-code")?.commands).toBeNull();
    // A report of commands alone holds nothing to keep: no row for it.
    expect(harnesses.collection.has("opencode")).toBe(false);
  });

  it("replaces the settings with each report", async () => {
    const handle = harnesses.harness("claude-code");
    await handle.recordOffer(report({ configOptions: models("opus") }));
    await handle.recordOffer(report({ configOptions: models("sonnet") }));

    expect(catalogOf("claude-code")?.configOptions).toEqual(models("sonnet"));
  });

  it("starts over for a report under another definition", async () => {
    const handle = harnesses.harness("claude-code");
    await handle.recordOffer(report({ configOptions: models("opus") }));
    await harnesses.collection.update("claude-code", (row) => {
      row.catalog!.commands = [{ name: "review", description: "" }];
    }).isPersisted.promise;
    const edited = { ...claude, env: { ANTHROPIC_MODEL: "sonnet" } };

    await handle.recordOffer(report({ harness: edited, configOptions: models("sonnet") }));

    expect(catalogOf("claude-code")).toMatchObject({
      configOptions: models("sonnet"),
      commands: null,
      definitionFingerprint: definitionFingerprint(edited),
    });
  });

  it("keeps nothing for a harness deleted since its session started", async () => {
    await harnesses
      .harness("custom:gone")
      .recordOffer(report({ harnessId: "custom:gone", configOptions: models("opus") }));

    expect(harnesses.collection.has("custom:gone")).toBe(false);
  });

  it("keeps what its sessions announce, once tracking, across a relaunch", async () => {
    const fresh = createNodeTestDb();
    const hooks = createHooks();
    const tracked = testHarnesses({ db: fresh, hooks, now: () => at });
    await tracked.ready();
    const stop = tracked.track();

    hooks.emit("agent:catalog", report({ configOptions: models("opus") }));
    await expect
      .poll(() => tracked.collection.get("claude-code")?.catalog?.configOptions)
      .toEqual(models("opus"));
    stop();

    const relaunched = testHarnesses({ db: fresh });
    await relaunched.ready();
    expect(relaunched.collection.get("claude-code")?.catalog?.configOptions).toEqual(
      models("opus"),
    );
  });
});

describe("definitionFingerprint", () => {
  it("tells definitions apart by command, args and env, not env order", () => {
    const base = { command: "claude-agent-acp", args: [], env: { A: "1", B: "2" } };
    expect(definitionFingerprint(base)).toBe(
      definitionFingerprint({ ...base, env: { B: "2", A: "1" } }),
    );
    expect(definitionFingerprint(base)).not.toBe(
      definitionFingerprint({ ...base, args: ["--x"] }),
    );
    expect(definitionFingerprint(base)).not.toBe(
      definitionFingerprint({ ...base, env: { A: "1", B: "3" } }),
    );
  });
});
