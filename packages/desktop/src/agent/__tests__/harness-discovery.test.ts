import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  candidateProbeEntries,
  createHarnessDiscovery,
  discoverHarnesses,
  HARNESS_DISCOVERY_KEY,
  HARNESS_OVERRIDES_KEY,
  HARNESS_SETTINGS_NAMESPACE,
} from "../harness-discovery";
import { BUILT_IN_HARNESSES } from "@notefig/shared/agent";
import type { KvApi } from "@/utils/kv-store";
import { testKv } from "@/testing/test-kv";

const runShellCommand = vi.fn();
const proc = { runShellCommand };

// Storage is real (in-memory SQLite), and fresh per test.
let kv: KvApi;

function storedDiscovery(): Promise<unknown> {
  return kv.read(HARNESS_SETTINGS_NAMESPACE, HARNESS_DISCOVERY_KEY);
}

beforeEach(() => {
  runShellCommand.mockReset();
  kv = testKv();
});

describe("discoverHarnesses", () => {
  it("parses sentinel-delimited output into per-id found/resolvedPath", async () => {
    runShellCommand.mockResolvedValue({
      stdout: "__MHD0__/usr/bin/foo__END____MHD1____END__",
      exitCode: 0,
    });
    const results = (await discoverHarnesses(proc, [
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
    await discoverHarnesses(proc, [
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
    const results = await discoverHarnesses(proc, [
      { id: "a", command: "foo" },
      { id: "b", command: "bar" },
    ]);
    expect(results).toBeNull();
  });

  it("returns {} without calling the adapter for an empty entry list", async () => {
    const results = await discoverHarnesses(proc, []);
    expect(results).toEqual({});
    expect(runShellCommand).not.toHaveBeenCalled();
  });

  it("uses a definition's probeCommand instead of the command -v default", async () => {
    runShellCommand.mockResolvedValue({ stdout: "", exitCode: 0 });
    await discoverHarnesses(proc, [
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

describe("startup", () => {
  it("runs one scan per session, applying stored override commands", async () => {
    const discovery = createHarnessDiscovery({ proc, kv });
    await kv.write(HARNESS_SETTINGS_NAMESPACE, HARNESS_OVERRIDES_KEY, {
      opencode: { id: "opencode", enabled: true, command: "ocv" },
    });
    runShellCommand.mockResolvedValue({ stdout: "", exitCode: 0 });

    discovery.startup();
    discovery.startup(); // second call: no-op
    await vi.waitFor(async () => expect(await storedDiscovery()).toBeDefined());

    expect(runShellCommand).toHaveBeenCalledTimes(1);
    // The overridden command (ocv) is what got probed, not the built-in.
    expect(runShellCommand.mock.calls[0][0]).toContain("ocv");
  });

  it("persists nothing when the platform can't run shell scripts", async () => {
    runShellCommand.mockRejectedValue(new Error("unsupported"));
    createHarnessDiscovery({ proc, kv }).startup();
    await vi.waitFor(() => expect(runShellCommand).toHaveBeenCalledTimes(1));
    // "Couldn't check" must not overwrite prior results with not-found.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await storedDiscovery()).toBeUndefined();
  });
});

describe("refresh", () => {
  it("writes results to the harness-settings/discovery key", async () => {
    runShellCommand.mockResolvedValue({ stdout: "", exitCode: 0 });

    await createHarnessDiscovery({ proc, kv }).refresh({}, []);

    expect(await storedDiscovery()).toMatchObject({
      [BUILT_IN_HARNESSES[0].id]: { harnessId: BUILT_IN_HARNESSES[0].id },
    });
  });
});
