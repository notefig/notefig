import { describe, it, expect, vi } from "vitest";
import { BUILT_IN_HARNESSES } from "@notefig/shared/agent";
import { testKv } from "@/testing/test-kv";
import { testHarnesses } from "@/testing/test-harnesses";
import {
  HARNESS_CUSTOM_KEY,
  HARNESS_DISCOVERY_KEY,
  HARNESS_OVERRIDES_KEY,
  HARNESS_SETTINGS_NAMESPACE,
} from "./harness-discovery";

/** A shell that finds every command it is asked about at `/bin/<i>`. */
function findingShell() {
  return {
    runShellCommand: vi.fn(async (script: string) => ({
      stdout: script
        .split("; ")
        .map((_, i) => `__MHD${i}__/bin/${i}__END__`)
        .join(""),
      exitCode: 0,
    })),
  };
}

describe("harnesses", () => {
  it("labels a harness from its settings, a built-in, or its raw id", async () => {
    const kv = testKv();
    const harnesses = testHarnesses({ kv });
    expect(harnesses.label("devin")).toBe("Devin");
    expect(harnesses.label("custom:gone")).toBe("custom:gone");

    await kv.write(HARNESS_SETTINGS_NAMESPACE, HARNESS_CUSTOM_KEY, [
      { id: "custom:1", label: "Lab", command: "lab-acp" },
    ]);
    expect(harnesses.label("custom:1")).toBe("Lab");
    expect(harnesses.configured().map((h) => h.id)).toContain("custom:1");
  });
});

describe("rescan", () => {
  it("checks every harness in one shell, with its overridden command", async () => {
    const kv = testKv();
    const proc = findingShell();
    await kv.write(HARNESS_SETTINGS_NAMESPACE, HARNESS_OVERRIDES_KEY, {
      opencode: { id: "opencode", enabled: true, command: "ocv" },
    });

    const results = await testHarnesses({ kv, proc }).rescan();

    expect(proc.runShellCommand).toHaveBeenCalledTimes(1);
    expect(proc.runShellCommand.mock.calls[0][0]).toContain("ocv");
    expect(Object.keys(results!).sort()).toEqual(
      BUILT_IN_HARNESSES.map((h) => h.id).sort(),
    );
    expect(
      await kv.read(HARNESS_SETTINGS_NAMESPACE, HARNESS_DISCOVERY_KEY),
    ).toEqual(results);
  });

  it("records nothing when the shell can't run", async () => {
    const kv = testKv();
    expect(await testHarnesses({ kv }).rescan()).toBeNull();
    expect(
      await kv.read(HARNESS_SETTINGS_NAMESPACE, HARNESS_DISCOVERY_KEY),
    ).toBeUndefined();
  });

  it("skips a disabled custom entry", async () => {
    const kv = testKv();
    await kv.write(HARNESS_SETTINGS_NAMESPACE, HARNESS_CUSTOM_KEY, [
      { id: "custom:off", label: "Off", command: "off-acp", enabled: false },
    ]);
    const results = await testHarnesses({ kv, proc: findingShell() }).rescan();
    expect(results!["custom:off"]).toBeUndefined();
  });
});

describe("a harness's rescan", () => {
  it("checks that harness alone, leaving the others' verdicts standing", async () => {
    const kv = testKv();
    const proc = findingShell();
    const harnesses = testHarnesses({ kv, proc });
    await harnesses.rescan();
    const before = await kv.read<Record<string, { probedAt: number }>>(
      HARNESS_SETTINGS_NAMESPACE,
      HARNESS_DISCOVERY_KEY,
    );

    const verdict = await harnesses.harness("devin").rescan();

    expect(proc.runShellCommand).toHaveBeenCalledTimes(2);
    expect(proc.runShellCommand.mock.calls[1][0]).toContain("devin");
    expect(proc.runShellCommand.mock.calls[1][0]).not.toContain("opencode");
    expect(verdict).toMatchObject({ harnessId: "devin", found: true });
    const after = await kv.read<Record<string, unknown>>(
      HARNESS_SETTINGS_NAMESPACE,
      HARNESS_DISCOVERY_KEY,
    );
    expect(after!.opencode).toEqual(before!.opencode);
    expect(after!.devin).toEqual(verdict);
  });

  it("shares one shell with the harnesses rescanned in the same tick", async () => {
    const proc = findingShell();
    const harnesses = testHarnesses({ proc });
    const [claude, devin] = await Promise.all([
      harnesses.harness("claude-code").rescan(),
      harnesses.harness("devin").rescan(),
    ]);
    expect(proc.runShellCommand).toHaveBeenCalledTimes(1);
    expect(claude?.found).toBe(true);
    expect(devin?.found).toBe(true);
  });

  it("checks a disabled custom entry asked for by name", async () => {
    const kv = testKv();
    await kv.write(HARNESS_SETTINGS_NAMESPACE, HARNESS_CUSTOM_KEY, [
      { id: "custom:off", label: "Off", command: "off-acp", enabled: false },
    ]);
    const proc = findingShell();
    const verdict = await testHarnesses({ kv, proc })
      .harness("custom:off")
      .rescan();
    expect(proc.runShellCommand.mock.calls[0][0]).toContain("off-acp");
    expect(verdict).toMatchObject({ harnessId: "custom:off", found: true });
  });

  it("is null, without a shell, for an id that names no harness", async () => {
    const proc = findingShell();
    expect(await testHarnesses({ proc }).harness("custom:gone").rescan()).toBeNull();
    expect(proc.runShellCommand).not.toHaveBeenCalled();
  });
});
