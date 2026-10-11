import { describe, it, expect, vi } from "vitest";
import { createLoopbackPair } from "@notefig/agent";
import { BUILT_IN_HARNESSES } from "@notefig/shared/agent";
import { FakeAgent } from "../mock-harness";
import { probeHarnessSession } from "../harness-probe";

const claude = BUILT_IN_HARNESSES.find((harness) => harness.id === "claude-code")!;

/** A harness over a loopback pair, and the probe's view of spawning it. */
function harnessProcess() {
  const [client, agentSide] = createLoopbackPair();
  const agent = new FakeAgent(agentSide);
  const close = vi.spyOn(client, "close");
  const spawned: { workspacePath: string; harnessId: string }[] = [];
  const createTransport = vi.fn(
    (spec: { workspacePath: string; harness: { id: string } }) => {
      spawned.push({ workspacePath: spec.workspacePath, harnessId: spec.harness.id });
      return client;
    },
  );
  return { agent, close, spawned, createTransport };
}

const probe = (
  createTransport: Parameters<typeof probeHarnessSession>[0]["createTransport"],
  overrides: Partial<Parameters<typeof probeHarnessSession>[0]> = {},
) =>
  probeHarnessSession({
    harness: claude,
    adapter: {},
    createTransport,
    cwd: "/tmp/probe",
    settleMs: 10,
    ...overrides,
  });

describe("probeHarnessSession", () => {
  it("keeps what the session reports, its version included, then deletes it and stops the harness", async () => {
    const { agent, close, spawned, createTransport } = harnessProcess();
    agent.initializeResult = {
      ...agent.initializeResult,
      agentInfo: { name: "claude-agent-acp", version: "0.31.0" },
      agentCapabilities: { sessionCapabilities: { delete: {} } },
    };
    agent.newSessionResult = {
      sessionId: "sess_probe",
      models: {
        currentModelId: "opus",
        availableModels: [{ modelId: "opus", name: "Opus" }],
      },
    };
    agent.commandsAfterNewSession = [{ name: "review", description: "Review" }];

    const catalog = await probe(createTransport);

    expect(spawned).toEqual([{ workspacePath: "/tmp/probe", harnessId: "claude-code" }]);
    expect(agent.newSessionParams).toMatchObject({ cwd: "/tmp/probe", mcpServers: [] });
    expect(catalog).toEqual({
      configOptions: [
        expect.objectContaining({ id: "model", currentValue: "opus" }),
      ],
      commands: [{ name: "review", description: "Review" }],
      harnessVersion: "0.31.0",
    });
    expect(agent.deleteSessionParams).toEqual({ sessionId: "sess_probe" });
    expect(agent.closeSessionParams).toBeNull();
    expect(close).toHaveBeenCalled();
  });

  it("closes the session where the harness can't delete one", async () => {
    const { agent, createTransport } = harnessProcess();

    const catalog = await probe(createTransport);

    expect(catalog).toEqual({ configOptions: [], commands: null });
    expect(agent.deleteSessionParams).toBeNull();
    expect(agent.closeSessionParams).toEqual({ sessionId: "sess_test" });
  });

  it("finds nothing, and stops the harness, when the session can't open", async () => {
    const { agent, close, createTransport } = harnessProcess();
    agent.onNewSession = async () => {
      throw new Error("not signed in");
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await probe(createTransport)).toBeNull();
    expect(close).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("finds nothing when the harness hangs", async () => {
    const { agent, close, createTransport } = harnessProcess();
    agent.onNewSession = () => new Promise(() => {});

    expect(await probe(createTransport, { timeoutMs: 30 })).toBeNull();
    expect(close).toHaveBeenCalled();
  });

  it("grants nothing, even a request that offers an allow option", async () => {
    const { agent, createTransport } = harnessProcess();
    let answer: unknown;
    agent.onNewSession = async (_params, a) => {
      answer = await a.request("session/request_permission", {
        sessionId: "sess_test",
        toolCall: { toolCallId: "tc1", title: "Run setup" },
        options: [
          { optionId: "yes", name: "Allow", kind: "allow_always" },
          { optionId: "no", name: "Reject", kind: "reject_once" },
        ],
      });
      return { sessionId: "sess_test" };
    };

    await probe(createTransport);

    expect(answer).toEqual({ outcome: { outcome: "cancelled" } });
  });

  it("stops a harness that finishes starting after the deadline", async () => {
    const [client, agentSide] = createLoopbackPair();
    new FakeAgent(agentSide);
    let finishStart!: () => void;
    vi.spyOn(client, "start").mockImplementation(
      () => new Promise<void>((resolve) => (finishStart = resolve)),
    );
    const close = vi.spyOn(client, "close");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await probe(() => client, { timeoutMs: 20 })).toBeNull();
    close.mockClear();
    finishStart();

    await vi.waitFor(() => expect(close).toHaveBeenCalled());
    warn.mockRestore();
  });

  it("finds nothing when the harness won't spawn", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const catalog = await probe(() => {
      throw new Error("ENOENT");
    });
    expect(catalog).toBeNull();
    warn.mockRestore();
  });
});
