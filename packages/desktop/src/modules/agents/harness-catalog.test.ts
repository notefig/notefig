import { describe, it, expect, beforeEach, vi } from "vitest";
import { createHooks, type CoreHookMap } from "@notefig/core";
import {
  BUILT_IN_HARNESSES,
  type AvailableCommand,
  type HarnessDefinition,
  type SessionConfigSelect,
} from "@notefig/shared/agent";
import type { DiscoveredCatalog } from "@/modules/harness-adapters";
import { createNodeTestDb, type NodeTestDb } from "@/testing/node-db";
import { testHarnesses } from "@/testing/test-harnesses";
import type { HarnessesApi } from "./harnesses";
import {
  CATALOG_REFRESH_MS,
  definitionFingerprint,
  type CatalogProbe,
} from "./harness-catalog";

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

describe("probing a harness's catalog", () => {
  let db: NodeTestDb;
  let clock: number;

  const command = (name: string): AvailableCommand => ({ name, description: name });

  const found = (current = "opus"): DiscoveredCatalog => ({
    configOptions: models(current),
    commands: [command("review")],
    harnessVersion: "1.0.0",
  });

  /** A probe that finds what `run` returns, and counts. */
  function fakeProbe(
    run: (definition: HarnessDefinition) => Promise<DiscoveredCatalog | null> = async () =>
      found(),
  ) {
    const calls: string[] = [];
    const probe: CatalogProbe = {
      has: (definition) => !definition.id.startsWith("custom:"),
      run: vi.fn(async (definition: HarnessDefinition) => {
        calls.push(definition.id);
        return run(definition);
      }),
    };
    return { probe, calls };
  }

  /** A probe that holds its first run until released. */
  function heldProbe(result: () => DiscoveredCatalog = () => found()) {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const fake = fakeProbe(async () => {
      if (fake.calls.length === 1) await held;
      return result();
    });
    return { ...fake, release: () => release() };
  }

  async function harnessesWith(probe?: CatalogProbe, proc?: Parameters<typeof testHarnesses>[0]) {
    const harnesses = testHarnesses({ db, probe, now: () => clock, ...proc });
    await harnesses.ready();
    return harnesses;
  }

  const catalogOf = (harnesses: HarnessesApi, harnessId = "claude-code") =>
    harnesses.collection.get(harnessId)?.catalog;

  const edit = (harnesses: HarnessesApi) =>
    harnesses
      .harness("claude-code")
      .saveOverride({ id: "claude-code", enabled: true, env: { DEBUG: "1" } });

  beforeEach(() => {
    db = createNodeTestDb();
    clock = 1_000_000;
  });

  it("probes a harness never probed once, concurrent asks sharing it", async () => {
    const { probe, calls } = fakeProbe();
    const harnesses = await harnessesWith(probe);
    const claudeCode = harnesses.harness("claude-code");

    await Promise.all([claudeCode.refreshCatalog(), claudeCode.refreshCatalog()]);

    expect(calls).toEqual(["claude-code"]);
    expect(catalogOf(harnesses)).toEqual({
      configOptions: models("opus"),
      commands: [command("review")],
      source: "probe",
      fetchedAt: clock,
      probedAt: clock,
      harnessVersion: "1.0.0",
      definitionFingerprint: definitionFingerprint(claude),
    });
  });

  it("doesn't probe again while the findings stand, and does once a week has passed", async () => {
    const { probe, calls } = fakeProbe();
    const harnesses = await harnessesWith(probe);
    const claudeCode = harnesses.harness("claude-code");
    await claudeCode.refreshCatalog();

    clock += CATALOG_REFRESH_MS - 1;
    await claudeCode.refreshCatalog();
    expect(calls).toHaveLength(1);

    clock += 1;
    await claudeCode.refreshCatalog();
    expect(calls).toHaveLength(2);
  });

  it("probes every enabled harness in turn, the stale ones only", async () => {
    const { probe, calls } = fakeProbe();
    const harnesses = await harnessesWith(probe);
    await harnesses.harness("devin").setEnabled(false);
    await harnesses.harness("claude-code").refreshCatalog();

    await harnesses.refreshCatalogs();

    expect(calls).toEqual(["claude-code", "opencode", "gemini-cli"]);
  });

  it("probes a harness its install check finds", async () => {
    const { probe, calls } = fakeProbe();
    const proc = {
      runShellCommand: vi.fn(async () => ({ stdout: "__MHD0__/bin/claude__END__", exitCode: 0 })),
    };
    const harnesses = await harnessesWith(probe, { proc });

    await harnesses.harness("claude-code").rescan();

    await vi.waitFor(() => expect(catalogOf(harnesses)?.probedAt).toBe(clock));
    expect(calls).toEqual(["claude-code"]);
  });

  it("probes again after the harness is edited", async () => {
    const { probe, calls } = fakeProbe();
    const harnesses = await harnessesWith(probe);
    await harnesses.harness("claude-code").refreshCatalog();

    await edit(harnesses);
    await harnesses.harness("claude-code").refreshCatalog();

    expect(calls).toHaveLength(2);
    expect(catalogOf(harnesses)?.definitionFingerprint).toBe(
      definitionFingerprint(harnesses.harness("claude-code").definition()!),
    );
  });

  it("probes again after an edit even when a session under the new definition reported first", async () => {
    const { probe, calls } = fakeProbe();
    const harnesses = await harnessesWith(probe);
    const claudeCode = harnesses.harness("claude-code");
    await claudeCode.refreshCatalog();

    await edit(harnesses);
    await claudeCode.recordOffer(
      report({
        harness: claudeCode.definition()!,
        harnessVersion: "1.0.0",
        configOptions: models("sonnet"),
      }),
    );
    await claudeCode.refreshCatalog();

    expect(calls).toHaveLength(2);
    expect(catalogOf(harnesses)?.commands).toEqual([command("review")]);
  });

  it("drops a probe's findings when the harness was edited while it ran", async () => {
    const { probe, calls, release } = heldProbe();
    const harnesses = await harnessesWith(probe);

    const probing = harnesses.harness("claude-code").refreshCatalog();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    await edit(harnesses);
    release();
    await probing;

    expect(catalogOf(harnesses)).toBeUndefined();
  });

  it("keeps settings a session reported while the probe ran", async () => {
    const { probe, calls, release } = heldProbe(() => found("opus"));
    const harnesses = await harnessesWith(probe);
    const claudeCode = harnesses.harness("claude-code");

    const probing = claudeCode.refreshCatalog();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    await claudeCode.recordOffer(report({ configOptions: models("sonnet") }));
    release();
    await probing;

    expect(catalogOf(harnesses)?.configOptions).toEqual(models("sonnet"));
    expect(catalogOf(harnesses)?.commands).toEqual([command("review")]);
  });

  it("saves its own settings when the session that reported during it ran an older definition", async () => {
    const { probe, calls, release } = heldProbe(() => found("opus"));
    const harnesses = await harnessesWith(probe);
    await edit(harnesses);
    const claudeCode = harnesses.harness("claude-code");

    const probing = claudeCode.refreshCatalog();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    // A session started before the edit, on the stock definition.
    await claudeCode.recordOffer(report({ configOptions: models("sonnet") }));
    release();
    await probing;

    expect(catalogOf(harnesses)?.configOptions).toEqual(models("opus"));
  });

  it("keeps a probe's findings but not as fresh when a session reported another version meanwhile", async () => {
    const { probe, calls, release } = heldProbe();
    const harnesses = await harnessesWith(probe);
    const claudeCode = harnesses.harness("claude-code");

    const probing = claudeCode.refreshCatalog();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    await claudeCode.recordOffer(report({ harnessVersion: "2.0.0" }));
    release();
    await probing;

    expect(catalogOf(harnesses)?.commands).toEqual([command("review")]);
    expect(catalogOf(harnesses)?.probedAt).toBeUndefined();
    await claudeCode.refreshCatalog();
    expect(calls).toHaveLength(2);
  });

  it("probes again once a session reports another harness version", async () => {
    // The harness was updated after the first probe.
    const { probe, calls } = fakeProbe(async () => ({
      ...found(),
      harnessVersion: calls.length === 1 ? "1.0.0" : "1.1.0",
    }));
    const harnesses = await harnessesWith(probe);
    const claudeCode = harnesses.harness("claude-code");
    await claudeCode.refreshCatalog();

    await claudeCode.recordOffer(report({ harnessVersion: "1.0.0" }));
    await claudeCode.refreshCatalog();
    expect(calls).toHaveLength(1);

    await claudeCode.recordOffer(report({ harnessVersion: "1.1.0" }));
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    await claudeCode.refreshCatalog();
    expect(catalogOf(harnesses)?.probedAt).toBe(clock);
  });

  it("writes nothing when the probe finds nothing or throws, and waits before trying again", async () => {
    let result: () => Promise<DiscoveredCatalog | null> = async () => found("opus");
    const { probe, calls } = fakeProbe(() => result());
    const harnesses = await harnessesWith(probe);
    const claudeCode = harnesses.harness("claude-code");
    await claudeCode.refreshCatalog();
    const before = catalogOf(harnesses);

    clock += CATALOG_REFRESH_MS;
    result = async () => null;
    await claudeCode.refreshCatalog();
    expect(catalogOf(harnesses)).toEqual(before);

    // Backing off: no second probe straight away.
    await claudeCode.refreshCatalog();
    expect(calls).toHaveLength(2);

    clock += 11 * 60 * 1000;
    result = async () => {
      throw new Error("crashed");
    };
    await claudeCode.refreshCatalog();
    expect(calls).toHaveLength(3);
    expect(catalogOf(harnesses)).toEqual(before);
  });

  it("never replaces a list with an empty one", async () => {
    let result = found("opus");
    const { probe } = fakeProbe(async () => result);
    const harnesses = await harnessesWith(probe);
    const claudeCode = harnesses.harness("claude-code");
    await claudeCode.refreshCatalog();

    clock += CATALOG_REFRESH_MS;
    result = { configOptions: models("sonnet"), commands: [] };
    await claudeCode.refreshCatalog();

    expect(catalogOf(harnesses)?.configOptions).toEqual(models("sonnet"));
    expect(catalogOf(harnesses)?.commands).toEqual([command("review")]);
  });

  it("runs one probe at a time across harnesses", async () => {
    let running = 0;
    let most = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const { probe, calls } = fakeProbe(async () => {
      running++;
      most = Math.max(most, running);
      if (calls.length === 1) await held;
      running--;
      return found();
    });
    const harnesses = await harnessesWith(probe);

    const first = harnesses.harness("claude-code").refreshCatalog();
    const second = harnesses.harness("devin").refreshCatalog();
    await vi.waitFor(() => expect(calls).toEqual(["claude-code"]));
    release();
    await Promise.all([first, second]);

    expect(calls).toEqual(["claude-code", "devin"]);
    expect(most).toBe(1);
  });

  it("never probes without a probe (a browser, the tunnel)", async () => {
    const harnesses = await harnessesWith(undefined);
    await harnesses.refreshCatalogs();
    expect(harnesses.collection.size).toBe(0);
  });

  it("never probes a harness switched off, one not found, or one with no probe", async () => {
    const proc = { runShellCommand: vi.fn(async () => ({ stdout: "", exitCode: 0 })) };
    const { probe, calls } = fakeProbe();
    const harnesses = await harnessesWith(probe, { proc });
    await harnesses.harness("devin").rescan();
    await harnesses.harness("gemini-cli").setEnabled(false);
    await harnesses.harness("custom:lab").saveCustom({
      id: "custom:lab",
      label: "Lab",
      command: "lab-acp",
      args: [],
      env: {},
      mcpRegistrationOverride: "none",
      enabled: true,
    });

    await harnesses.harness("devin").refreshCatalog();
    await harnesses.harness("gemini-cli").refreshCatalog();
    await harnesses.harness("custom:lab").refreshCatalog();

    expect(harnesses.collection.get("devin")?.install?.found).toBe(false);
    expect(calls).toEqual([]);
  });
});
