import { describe, it, expect, vi, beforeEach } from "vitest";

const runShellCommand = vi.fn();
const setKv = vi.fn();
const getKv = vi.fn();
const getAllKv = vi.fn(async () => ({}));

vi.mock("@/adapters", () => ({
  platformAdapter: {
    proc: {
      runShellCommand: (...args: unknown[]) => runShellCommand(...args),
    },
    kv: {
      setKv: (...args: unknown[]) => setKv(...args),
      getKv: (...args: unknown[]) => getKv(...args),
      getAllKv: () => getAllKv(),
    },
  },
}));

import {
  candidateProbeEntries,
  discoverHarnesses,
  ensureStartupHarnessDiscovery,
  refreshHarnessDiscovery,
  resetStartupHarnessDiscoveryForTest,
} from "../harness-discovery";
import { BUILT_IN_HARNESSES } from "@notefig/shared/agent";

beforeEach(() => {
  runShellCommand.mockReset();
  setKv.mockReset();
  getKv.mockReset();
  resetStartupHarnessDiscoveryForTest();
});

describe("discoverHarnesses", () => {
  it("parses sentinel-delimited output into per-id found/resolvedPath", async () => {
    runShellCommand.mockResolvedValue({
      stdout: "__MHD0__/usr/bin/foo__END____MHD1____END__",
      exitCode: 0,
    });
    const results = (await discoverHarnesses([
      { id: "a", command: "foo" },
      { id: "b", command: "bar" },
    ]))!;
    expect(results.a).toMatchObject({
      harnessId: "a",
      found: true,
      resolvedPath: "/usr/bin/foo",
    });
    expect(results.b).toMatchObject({ harnessId: "b", found: false });
    expect(results.b.resolvedPath).toBeUndefined();
  });

  it("batches every command into a single runShellCommand call", async () => {
    runShellCommand.mockResolvedValue({ stdout: "", exitCode: 0 });
    await discoverHarnesses([
      { id: "a", command: "foo" },
      { id: "b", command: "bar" },
      { id: "c", command: "baz" },
    ]);
    expect(runShellCommand).toHaveBeenCalledTimes(1);
  });

  it("returns null when the probe can't run — never an affirmative not-found", async () => {
    runShellCommand.mockRejectedValue(
      new Error("Shell commands are not supported on this adapter."),
    );
    const results = await discoverHarnesses([
      { id: "a", command: "foo" },
      { id: "b", command: "bar" },
    ]);
    expect(results).toBeNull();
  });

  it("returns {} without calling the adapter for an empty entry list", async () => {
    const results = await discoverHarnesses([]);
    expect(results).toEqual({});
    expect(runShellCommand).not.toHaveBeenCalled();
  });

  it("uses a definition's probeCommand instead of the command -v default", async () => {
    runShellCommand.mockResolvedValue({ stdout: "", exitCode: 0 });
    await discoverHarnesses([
      { id: "a", command: "npx", probeCommand: "command -v claude" },
      { id: "b", command: "bar" },
    ]);
    const script = runShellCommand.mock.calls[0][0] as string;
    expect(script).toContain("command -v claude");
    expect(script).not.toContain("command -v 'npx'");
    expect(script).toContain("command -v 'bar'");
  });
});

describe("candidateProbeEntries", () => {
  it("uses built-in commands and probes when there are no overrides", () => {
    const entries = candidateProbeEntries({}, []);
    expect(entries).toEqual(
      BUILT_IN_HARNESSES.map((h) => ({
        id: h.id,
        command: h.command,
        probeCommand: h.probeCommand,
      })),
    );
  });

  it("prefers an override's command over the built-in default", () => {
    const entries = candidateProbeEntries(
      { opencode: { id: "opencode", enabled: true, command: "ocv" } },
      [],
    );
    expect(entries.find((e) => e.id === "opencode")).toEqual({
      id: "opencode",
      command: "ocv",
    });
  });

  it("includes enabled custom entries and excludes disabled ones", () => {
    const entries = candidateProbeEntries({}, [
      {
        id: "custom:1",
        label: "L",
        command: "custom-bin",
        args: [],
        env: {},
        mcpRegistrationOverride: "none",
        enabled: true,
      },
      {
        id: "custom:2",
        label: "L2",
        command: "other-bin",
        args: [],
        env: {},
        mcpRegistrationOverride: "none",
        enabled: false,
      },
    ]);
    expect(entries).toContainEqual({ id: "custom:1", command: "custom-bin" });
    expect(entries.find((e) => e.id === "custom:2")).toBeUndefined();
  });
});

describe("ensureStartupHarnessDiscovery", () => {
  it("runs one scan per session, applying stored override commands", async () => {
    getKv.mockImplementation(async (_ns: string, key: string) =>
      key === "overrides"
        ? { opencode: { id: "opencode", enabled: true, command: "ocv" } }
        : undefined,
    );
    runShellCommand.mockResolvedValue({ stdout: "", exitCode: 0 });

    ensureStartupHarnessDiscovery();
    ensureStartupHarnessDiscovery(); // second call: no-op
    await vi.waitFor(() => expect(setKv).toHaveBeenCalledTimes(1));

    expect(runShellCommand).toHaveBeenCalledTimes(1);
    // The overridden command (ocv) is what got probed, not the built-in.
    expect(runShellCommand.mock.calls[0][0]).toContain("ocv");
  });

  it("persists nothing when the platform can't run shell scripts", async () => {
    getKv.mockResolvedValue(undefined);
    runShellCommand.mockRejectedValue(new Error("unsupported"));
    ensureStartupHarnessDiscovery();
    await vi.waitFor(() => expect(runShellCommand).toHaveBeenCalledTimes(1));
    // "Couldn't check" must not overwrite prior results with not-found.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(setKv).not.toHaveBeenCalled();
  });
});

describe("refreshHarnessDiscovery", () => {
  it("writes results to the harness-settings/discovery KV key", async () => {
    runShellCommand.mockResolvedValue({ stdout: "", exitCode: 0 });
    await refreshHarnessDiscovery({}, []);
    expect(setKv).toHaveBeenCalledWith(
      "harness-settings",
      "discovery",
      expect.objectContaining({
        [BUILT_IN_HARNESSES[0].id]: expect.objectContaining({
          harnessId: BUILT_IN_HARNESSES[0].id,
        }),
      }),
    );
  });
});
