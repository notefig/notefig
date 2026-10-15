import { describe, it, expect, vi, beforeEach } from "vitest";
import { createLoopbackPair } from "@notefig/agent";
import {
  BUILT_IN_HARNESSES,
  type HarnessDefinition,
  type SessionConfigSelect,
} from "@notefig/shared/agent";
import {
  createHarnessAdapters,
  type CatalogProbeIo,
  type HarnessAdapter,
  type HarnessCatalog,
} from "@/modules/harness-adapters";
import { createKv, type KvApi } from "@/modules/kv";
import { createNodeTestDb } from "@/testing/node-db";
import { testHarnesses } from "@/testing/test-harnesses";
import { FakeAgent } from "../mock-harness";
import { createHarnessProbe } from "../harness-probe";
import type { HarnessesApi } from "../harnesses";

const DAY = 24 * 60 * 60 * 1000;

const models = (...values: string[]): SessionConfigSelect[] => [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: values[0],
    options: values.map((value) => ({ value, name: value })),
  },
];

const found = (model = "opus"): HarnessCatalog => ({
  configOptions: models(model),
  commands: [{ name: "review", description: "Review" }],
});

/** A shell that finds every command an install check asks about. */
const findingShell = {
  runShellCommand: async (script: string) => ({
    stdout: script
      .split("; ")
      .map((_, i) => `__MHD${i}__/bin/${i}__END__`)
      .join(""),
    exitCode: 0,
  }),
};

const NO_PROC = {
  runShellCommand: () => Promise.reject(new Error("no shell")),
  createAgentTransport: () => {
    throw new Error("no spawning");
  },
};

describe("the harness probe", () => {
  let clock: number;
  let kv: KvApi;
  let harnesses: HarnessesApi;
  /** Each probe, by harness id, in the order they ran. */
  let calls: string[];
  let discover: (definition: HarnessDefinition) => Promise<HarnessCatalog | null>;

  /** Every built-in but custom entries can be probed; each probe counts. */
  const adapterFor = (definition: HarnessDefinition) =>
    (definition.id.startsWith("custom:")
      ? {}
      : {
          discoverCatalog: async () => {
            calls.push(definition.id);
            return discover(definition);
          },
        }) as HarnessAdapter;

  const probe = () =>
    createHarnessProbe({ harnesses, adapterFor, proc: NO_PROC, kv, now: () => clock });

  const catalogOf = (harnessId = "claude-code") =>
    harnesses.collection.get(harnessId)?.catalog;

  /** Every built-in switched off but these, then found by a rescan. */
  async function only(...ids: string[]) {
    for (const builtIn of BUILT_IN_HARNESSES) {
      if (!ids.includes(builtIn.id)) await harnesses.harness(builtIn.id).setEnabled(false);
    }
    await harnesses.rescan();
  }

  const edit = (env: Record<string, string>) =>
    harnesses.harness("claude-code").saveOverride({ id: "claude-code", enabled: true, env });

  /** Hold each probe until released. */
  function hold() {
    const releases: (() => void)[] = [];
    const previous = discover;
    discover = (definition) =>
      new Promise((resolve) => releases.push(() => resolve(previous(definition))));
    return {
      release: async (count = 1) => {
        await vi.waitFor(() => expect(releases.length).toBeGreaterThanOrEqual(count));
        releases.splice(0, count).forEach((release) => release());
      },
    };
  }

  beforeEach(async () => {
    clock = 1_000_000;
    const db = createNodeTestDb();
    kv = createKv(() => db.get());
    harnesses = testHarnesses({ db, kv, proc: findingShell });
    await harnesses.ready();
    calls = [];
    discover = async () => found();
  });

  it("probes each harness that is on and found, and keeps what it found", async () => {
    await only("claude-code", "opencode");

    await probe().check(["claude-code", "opencode", "devin"]);

    expect(calls).toEqual(["claude-code", "opencode"]);
    expect(catalogOf()).toEqual(found());
    expect(catalogOf("opencode")).toEqual(found());
  });

  it("doesn't probe again while its findings stand, even after a relaunch, and does a day on", async () => {
    await only("claude-code");
    await probe().check(["claude-code"]);

    await probe().check(["claude-code"]);
    clock += DAY - 1;
    await probe().check(["claude-code"]);
    expect(calls).toEqual(["claude-code"]);

    clock += 1;
    await probe().check(["claude-code"]);
    expect(calls).toEqual(["claude-code", "claude-code"]);
  });

  it("probes at start, and again on its own when the harness is edited", async () => {
    await only("claude-code");
    const stop = probe().start();
    await vi.waitFor(() => expect(catalogOf()).toEqual(found()));

    discover = async () => found("sonnet");
    await edit({ DEBUG: "1" });

    await vi.waitFor(() => expect(catalogOf()).toEqual(found("sonnet")));
    expect(calls).toEqual(["claude-code", "claude-code"]);
    stop();
  });

  it("probes a harness once its install check finds it", async () => {
    const stop = probe().start();
    await vi.waitFor(() => expect(harnesses.isReady()).toBe(true));
    expect(calls).toEqual([]);

    await harnesses.harness("claude-code").rescan();

    await vi.waitFor(() => expect(calls).toContain("claude-code"));
    stop();
  });

  it("drops what a probe found for a definition edited while it ran, and probes the new one", async () => {
    await only("claude-code");
    const held = hold();
    const prober = probe();
    const first = prober.check(["claude-code"]);
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    await edit({ DEBUG: "1" });
    discover = async () => found("sonnet");
    const second = prober.check(["claude-code"]);
    await held.release();
    await Promise.all([first, second]);

    expect(calls).toEqual(["claude-code", "claude-code"]);
    expect(catalogOf()).toEqual(found("sonnet"));
  });

  it("starts nothing for a harness switched off while it waited its turn", async () => {
    await only("claude-code", "opencode");
    const held = hold();
    const prober = probe();
    const checked = prober.check(["claude-code", "opencode"]);

    await harnesses.harness("opencode").setEnabled(false);
    await held.release();
    await checked;

    expect(calls).toEqual(["claude-code"]);
  });

  it("runs one probe at a time", async () => {
    await only("claude-code", "opencode");
    const held = hold();
    const checked = probe().check(["claude-code", "opencode"]);

    await vi.waitFor(() => expect(calls).toEqual(["claude-code"]));
    await held.release();
    await vi.waitFor(() => expect(calls).toEqual(["claude-code", "opencode"]));
    await held.release();
    await checked;
  });

  it("writes nothing when a probe finds nothing or throws, and waits before trying that definition again", async () => {
    await only("claude-code");
    const prober = probe();
    await prober.check(["claude-code"]);
    discover = async () => null;
    clock += DAY;
    await prober.check(["claude-code"]);
    discover = async () => {
      throw new Error("crashed");
    };
    clock += 10 * 60 * 1000;
    await prober.check(["claude-code"]);
    expect(catalogOf()).toEqual(found());

    // Within the wait: not tried. An edit is tried at once.
    await prober.check(["claude-code"]);
    expect(calls).toHaveLength(3);
    discover = async () => found("sonnet");
    await edit({ DEBUG: "1" });
    await prober.check(["claude-code"]);
    expect(calls).toHaveLength(4);
    expect(catalogOf()).toEqual(found("sonnet"));
  });

  it("never probes a harness switched off, not found, or with no way to be", async () => {
    await harnesses.harness("custom:lab").saveCustom({
      id: "custom:lab",
      label: "Lab",
      command: "lab-acp",
      args: [],
      env: {},
      mcpRegistrationOverride: "session-new",
      enabled: true,
    });
    await only("claude-code");
    await harnesses.harness("claude-code").setEnabled(false);

    await probe().check(["claude-code", "opencode", "custom:lab"]);

    expect(calls).toEqual([]);
  });
});

describe("what a probe is handed", () => {
  const claude = BUILT_IN_HARNESSES.find((harness) => harness.id === "claude-code")!;
  const opencode = BUILT_IN_HARNESSES.find((harness) => harness.id === "opencode")!;

  /** The probe's view of one harness: the IO its adapter is handed. */
  async function ioFor(
    definition: HarnessDefinition,
    proc: Parameters<typeof createHarnessProbe>[0]["proc"],
  ): Promise<CatalogProbeIo> {
    const db = createNodeTestDb();
    const harnesses = testHarnesses({ db, proc: findingShell });
    await harnesses.ready();
    await harnesses.rescan();
    const { adapterFor } = createHarnessAdapters({ harnesses });
    let io!: CatalogProbeIo;
    await createHarnessProbe({
      harnesses: { ...harnesses, configured: () => [definition] },
      adapterFor: (harness) => ({
        ...adapterFor(harness),
        discoverCatalog: async (handed) => {
          io = handed;
          return null;
        },
      }),
      proc,
      kv: createKv(() => db.get()),
    }).check([definition.id]);
    return io;
  }

  it("runs the harness's own command, its env set, in the login shell", async () => {
    const runShellCommand = vi.fn(async () => ({ stdout: "out", exitCode: 0 }));
    const io = await ioFor(
      {
        ...opencode,
        command: "/opt/my opencode",
        env: { OPENCODE_CONFIG: "/x/it's.json", "bad name": "skipped" },
      },
      { runShellCommand, createAgentTransport: vi.fn() },
    );

    expect(await io.runHarness(["models"])).toEqual({ stdout: "out", exitCode: 0 });
    expect(runShellCommand).toHaveBeenCalledWith(
      "OPENCODE_CONFIG='/x/it'\\''s.json' '/opt/my opencode' 'models'",
    );
  });

  it("finds nothing when the shell can't run", async () => {
    const io = await ioFor(opencode, NO_PROC);
    expect(await io.runHarness(["models"])).toBeNull();
    expect(await io.probeSession()).toBeNull();
  });

  it("opens the throwaway session in the app's own temp directory", async () => {
    const [client, agentSide] = createLoopbackPair();
    const agent = new FakeAgent(agentSide);
    agent.commandsAfterNewSession = [{ name: "review", description: "Review" }];
    const createAgentTransport = vi.fn(() => client);
    const io = await ioFor(claude, {
      runShellCommand: async () => ({
        stdout: "motd\n__DIR__/private/tmp/notefig-harness-probe__END__",
        exitCode: 0,
      }),
      createAgentTransport,
    });

    const catalog = await io.probeSession();

    expect(createAgentTransport).toHaveBeenCalledWith(
      expect.objectContaining({ workspacePath: "/private/tmp/notefig-harness-probe" }),
    );
    expect(catalog?.commands).toEqual([{ name: "review", description: "Review" }]);
  }, 10_000);
});
