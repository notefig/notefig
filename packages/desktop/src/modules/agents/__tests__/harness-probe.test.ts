import { describe, it, expect, vi } from "vitest";
import { createLoopbackPair } from "@notefig/agent";
import { BUILT_IN_HARNESSES } from "@notefig/shared/agent";
import { FakeAgent } from "../mock-harness";
import { createCatalogProbe } from "../harness-probe";
import { createHarnessAdapters } from "@/modules/harness-adapters";

const claude = BUILT_IN_HARNESSES.find((harness) => harness.id === "claude-code")!;

/** A harness over a loopback pair, and where the probe spawned it. */
function harnessProcess() {
  const [client, agentSide] = createLoopbackPair();
  const agent = new FakeAgent(agentSide);
  const spawned: { workspacePath: string; harnessId: string }[] = [];
  const createTransport = vi.fn(
    (spec: { workspacePath: string; harness: { id: string } }) => {
      spawned.push({ workspacePath: spec.workspacePath, harnessId: spec.harness.id });
      return client;
    },
  );
  return { agent, spawned, createTransport };
}

describe("createCatalogProbe", () => {
  const opencode = BUILT_IN_HARNESSES.find((harness) => harness.id === "opencode")!;
  const { adapterFor } = createHarnessAdapters();

  it("runs the harness's own command, its env set, in the login shell", async () => {
    const runShellCommand = vi.fn(async () => ({
      stdout: "anthropic/claude-sonnet-4-5\n",
      exitCode: 0,
    }));
    const probe = createCatalogProbe({
      proc: { runShellCommand, createAgentTransport: vi.fn() },
      adapterFor,
    });

    const catalog = await probe.run({
      ...opencode,
      command: "/opt/my opencode",
      env: { OPENCODE_CONFIG: "/x/it's.json", "bad name": "skipped" },
    });

    expect(runShellCommand).toHaveBeenCalledWith(
      "OPENCODE_CONFIG='/x/it'\\''s.json' '/opt/my opencode' 'models'",
    );
    expect(catalog?.configOptions?.[0].currentValue).toBe("anthropic/claude-sonnet-4-5");
  });

  it("finds nothing when the shell can't run", async () => {
    const probe = createCatalogProbe({
      proc: {
        runShellCommand: () => Promise.reject(new Error("no shell")),
        createAgentTransport: vi.fn(),
      },
      adapterFor,
    });
    expect(await probe.run(opencode)).toBeNull();
  });

  it("opens the throwaway session in the app's own temp directory", async () => {
    const { agent, spawned, createTransport } = harnessProcess();
    agent.commandsAfterNewSession = [{ name: "review", description: "Review" }];
    const runShellCommand = vi.fn(async () => ({
      stdout: "motd\n__DIR__/private/tmp/notefig-harness-probe__END__",
      exitCode: 0,
    }));
    const probe = createCatalogProbe({
      proc: { runShellCommand, createAgentTransport: createTransport as never },
      adapterFor,
    });

    const catalog = await probe.run(claude);

    expect(spawned).toEqual([
      { workspacePath: "/private/tmp/notefig-harness-probe", harnessId: "claude-code" },
    ]);
    expect(catalog?.commands).toEqual([{ name: "review", description: "Review" }]);
  }, 10_000);

  it("opens no session where there is no such directory", async () => {
    const createAgentTransport = vi.fn();
    const probe = createCatalogProbe({
      proc: {
        runShellCommand: () => Promise.reject(new Error("no shell")),
        createAgentTransport,
      },
      adapterFor,
    });
    expect(await probe.run(claude)).toBeNull();
    expect(createAgentTransport).not.toHaveBeenCalled();
  });

  it("probes the harnesses whose adapters can, and no custom one", () => {
    const probe = createCatalogProbe({
      proc: { runShellCommand: vi.fn(), createAgentTransport: vi.fn() },
      adapterFor,
    });
    expect(probe.has(claude)).toBe(true);
    expect(probe.has(opencode)).toBe(true);
    expect(probe.has({ ...claude, id: "custom:lab" })).toBe(false);
  });
});
