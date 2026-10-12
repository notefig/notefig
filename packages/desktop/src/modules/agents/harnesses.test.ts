import { describe, it, expect, vi } from "vitest";
import {
  BUILT_IN_HARNESSES,
  type CustomHarnessEntry,
} from "@notefig/shared/agent";
import { createKv } from "@/modules/kv";
import { createNodeTestDb } from "@/testing/node-db";
import { testHarnesses } from "@/testing/test-harnesses";
import type { Proc } from "./harness-discovery";
import type { HarnessesApi } from "./harnesses";
import {
  harnessSettingsRows,
  pickableHarnesses,
  probedHarnesses,
} from "./harness-settings";

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

function customEntry(partial: Partial<CustomHarnessEntry> = {}): CustomHarnessEntry {
  return {
    id: "custom:1",
    label: "Lab",
    command: "lab-acp",
    args: [],
    env: {},
    mcpRegistrationOverride: "none",
    enabled: true,
    ...partial,
  };
}

/** Harnesses over a database where an older version left these settings
 *  in KV — the way to start a test from settings without the install
 *  check a save runs. */
async function withLegacySettings(
  settings: { overrides?: unknown; custom?: unknown; discovery?: unknown },
  proc?: Proc,
) {
  const db = createNodeTestDb();
  const kv = createKv(() => db.get());
  for (const [key, value] of Object.entries(settings)) {
    await kv.write("harness-settings", key, value);
  }
  const harnesses = testHarnesses({ db, kv, proc });
  await harnesses.ready();
  return { db, kv, harnesses };
}

const rowsOf = (harnesses: HarnessesApi) => [...harnesses.collection.values()];

describe("harnesses", () => {
  it("labels a harness from its row, a built-in, or its raw id", async () => {
    const harnesses = testHarnesses();
    expect(harnesses.label("devin")).toBe("Devin");
    expect(harnesses.label("custom:gone")).toBe("custom:gone");

    await harnesses.harness("custom:1").saveCustom(customEntry());
    expect(harnesses.label("custom:1")).toBe("Lab");
    expect(harnesses.configured().map((h) => h.id)).toContain("custom:1");
  });

  it("keeps its rows across a relaunch", async () => {
    const db = createNodeTestDb();
    await testHarnesses({ db }).harness("custom:1").saveCustom(customEntry());

    const relaunched = testHarnesses({ db });
    await relaunched.ready();
    expect(relaunched.harness("custom:1").definition()?.label).toBe("Lab");
  });
});

describe("moving an older version's settings into rows", () => {
  it("writes a row per override, custom entry and verdict, then deletes the keys", async () => {
    const { kv, harnesses } = await withLegacySettings({
      overrides: { opencode: { id: "opencode", enabled: true, command: "ocv" } },
      custom: [customEntry(), customEntry({ id: "custom:2", label: "Second" })],
      discovery: {
        devin: { harnessId: "devin", found: false, probedAt: 1 },
      },
    });

    expect(harnesses.harness("opencode").definition()?.command).toBe("ocv");
    expect(
      harnessSettingsRows(rowsOf(harnesses))
        .filter((row) => row.origin === "custom")
        .map((row) => row.definition.label),
    ).toEqual(["Lab", "Second"]);
    expect(harnesses.collection.get("devin")?.install?.found).toBe(false);
    for (const key of ["overrides", "custom", "discovery"]) {
      expect(await kv.read("harness-settings", key)).toBeUndefined();
    }
  });

  it("drops what it can't trust: invalid rows and a deleted entry's verdict", async () => {
    const { harnesses } = await withLegacySettings({
      overrides: { opencode: { enabled: "yes" } },
      custom: [{ id: "custom:bad" }],
      discovery: {
        "custom:gone": { harnessId: "custom:gone", found: true, probedAt: 1 },
      },
    });
    expect(rowsOf(harnesses)).toEqual([]);
  });

  it("does nothing on a launch with no settings left in KV", async () => {
    const { db, harnesses } = await withLegacySettings({
      custom: [customEntry()],
    });
    await harnesses.harness("custom:1").setEnabled(false);

    const relaunched = testHarnesses({ db });
    await relaunched.ready();
    expect(relaunched.collection.get("custom:1")?.custom?.enabled).toBe(false);
  });
});

describe("rescan", () => {
  it("checks every harness in one shell, with its overridden command", async () => {
    const proc = findingShell();
    const { harnesses } = await withLegacySettings(
      { overrides: { opencode: { id: "opencode", enabled: true, command: "ocv" } } },
      proc,
    );

    const results = await harnesses.rescan();

    expect(proc.runShellCommand).toHaveBeenCalledTimes(1);
    expect(proc.runShellCommand.mock.calls[0][0]).toContain("ocv");
    expect(Object.keys(results!).sort()).toEqual(
      BUILT_IN_HARNESSES.map((h) => h.id).sort(),
    );
    expect(harnesses.collection.get("opencode")?.install).toEqual(
      results!.opencode,
    );
  });

  it("records nothing when the shell can't run", async () => {
    const harnesses = testHarnesses();
    expect(await harnesses.rescan()).toBeNull();
    expect(rowsOf(harnesses)).toEqual([]);
  });

  it("is null when the verdicts can't be saved, and the next one still runs", async () => {
    const { db, harnesses } = await withLegacySettings({}, findingShell());
    db.breakWrites("disk full");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await harnesses.rescan()).toBeNull();
    warn.mockRestore();

    db.repairWrites();
    expect(await harnesses.rescan()).not.toBeNull();
  });

  it("skips a disabled custom entry", async () => {
    const { harnesses } = await withLegacySettings(
      { custom: [customEntry({ enabled: false })] },
      findingShell(),
    );
    const results = await harnesses.rescan();
    expect(results!["custom:1"]).toBeUndefined();
  });
});

describe("a harness's rescan", () => {
  it("checks that harness alone, leaving the others' verdicts standing", async () => {
    const proc = findingShell();
    const harnesses = testHarnesses({ proc });
    await harnesses.rescan();
    const before = harnesses.collection.get("opencode")?.install;

    const verdict = await harnesses.harness("devin").rescan();

    expect(proc.runShellCommand).toHaveBeenCalledTimes(2);
    expect(proc.runShellCommand.mock.calls[1][0]).toContain("devin");
    expect(proc.runShellCommand.mock.calls[1][0]).not.toContain("opencode");
    expect(verdict).toMatchObject({ harnessId: "devin", found: true });
    expect(harnesses.collection.get("opencode")?.install).toEqual(before);
    expect(harnesses.collection.get("devin")?.install).toEqual(verdict);
  });

  it("shares one shell with the harnesses rescanned in the same tick", async () => {
    const proc = findingShell();
    const harnesses = testHarnesses({ proc });
    await harnesses.ready();
    const [claude, devin] = await Promise.all([
      harnesses.harness("claude-code").rescan(),
      harnesses.harness("devin").rescan(),
    ]);
    expect(proc.runShellCommand).toHaveBeenCalledTimes(1);
    expect(claude?.found).toBe(true);
    expect(devin?.found).toBe(true);
  });

  it("checks a disabled custom entry asked for by name", async () => {
    const proc = findingShell();
    const { harnesses } = await withLegacySettings(
      { custom: [customEntry({ enabled: false })] },
      proc,
    );
    const verdict = await harnesses.harness("custom:1").rescan();
    expect(proc.runShellCommand.mock.calls[0][0]).toContain("lab-acp");
    expect(verdict).toMatchObject({ harnessId: "custom:1", found: true });
  });

  it("is null, without a shell, for an id that names no harness", async () => {
    const proc = findingShell();
    expect(await testHarnesses({ proc }).harness("custom:gone").rescan()).toBeNull();
    expect(proc.runShellCommand).not.toHaveBeenCalled();
  });
});

describe("a harness's definition", () => {
  it("is a built-in with its override, a custom entry, or nothing", async () => {
    const { harnesses } = await withLegacySettings({
      overrides: { opencode: { id: "opencode", enabled: false, command: "ocv" } },
      custom: [customEntry({ enabled: false })],
    });
    // Switched off, still as configured.
    expect(harnesses.harness("opencode").definition()?.command).toBe("ocv");
    expect(harnesses.harness("custom:1").definition()?.label).toBe("Lab");
    expect(harnesses.harness("devin").definition()?.command).toBe("devin");
    expect(harnesses.harness("custom:gone").definition()).toBeUndefined();
  });
});

describe("a harness's settings", () => {
  it("saves an override and checks the install again", async () => {
    const proc = findingShell();
    const harnesses = testHarnesses({ proc });
    expect(
      await harnesses
        .harness("opencode")
        .saveOverride({ id: "opencode", enabled: true, command: "ocv" }),
    ).toBe(true);
    await vi.waitFor(() =>
      expect(proc.runShellCommand.mock.calls[0]?.[0]).toContain("ocv"),
    );

    await harnesses.harness("opencode").saveOverride(null);
    expect(harnesses.harness("opencode").definition()?.command).toBe("opencode");
  });

  it("writes no override for an id that is no built-in, nor a custom entry under a built-in's", async () => {
    const harnesses = testHarnesses();
    expect(
      await harnesses
        .harness("custom:1")
        .saveOverride({ id: "custom:1", enabled: false }),
    ).toBe(false);
    expect(
      await harnesses.harness("devin").saveCustom(customEntry({ id: "devin" })),
    ).toBe(false);
    expect(rowsOf(harnesses)).toEqual([]);
  });

  it("adds a custom entry under the handle's id, then replaces it", async () => {
    const harnesses = testHarnesses();
    await harnesses.harness("custom:1").saveCustom(customEntry({ id: "custom:other" }));
    await harnesses.harness("custom:1").saveCustom(customEntry({ label: "Renamed" }));
    const custom = harnesses.configured().filter((h) => h.id.startsWith("custom:"));
    expect(custom.map((h) => [h.id, h.label])).toEqual([["custom:1", "Renamed"]]);
  });

  it("rejects a custom entry the schema rejects, writing nothing", async () => {
    const harnesses = testHarnesses();
    expect(
      await harnesses.harness("custom:1").saveCustom(customEntry({ command: "" })),
    ).toBe(false);
    expect(harnesses.harness("custom:1").definition()).toBeUndefined();
  });

  it("keeps both of two edits made at once", async () => {
    const harnesses = testHarnesses();
    await Promise.all([
      harnesses.harness("custom:1").saveCustom(customEntry()),
      harnesses.harness("custom:2").saveCustom(customEntry({ id: "custom:2" })),
    ]);
    expect(harnesses.harness("custom:1").definition()).toBeDefined();
    expect(harnesses.harness("custom:2").definition()).toBeDefined();
  });

  it("switches a built-in off and back on, leaving no override behind", async () => {
    const harnesses = testHarnesses();
    await harnesses.harness("opencode").setEnabled(false);
    expect(pickableHarnesses(rowsOf(harnesses)).map((h) => h.id)).not.toContain(
      "opencode",
    );
    expect(
      harnessSettingsRows(rowsOf(harnesses)).find(
        (row) => row.definition.id === "opencode",
      ),
    ).toMatchObject({ enabled: false, origin: "builtin" });

    await harnesses.harness("opencode").setEnabled(true);
    expect(harnesses.collection.get("opencode")?.override).toBeUndefined();
    expect(pickableHarnesses(rowsOf(harnesses)).map((h) => h.id)).toContain(
      "opencode",
    );
  });

  it("switches a custom entry off and removes it with its row", async () => {
    const harnesses = testHarnesses();
    await harnesses.harness("custom:1").saveCustom(customEntry());
    await harnesses.harness("custom:1").setEnabled(false);
    expect(pickableHarnesses(rowsOf(harnesses)).map((h) => h.id)).not.toContain(
      "custom:1",
    );
    expect(
      harnessSettingsRows(rowsOf(harnesses)).map((row) => row.definition.id),
    ).toContain("custom:1");

    await harnesses.harness("custom:1").remove();
    expect(harnesses.collection.has("custom:1")).toBe(false);
  });

  it("removes no built-in", async () => {
    const harnesses = testHarnesses();
    await harnesses.harness("opencode").setEnabled(false);
    await harnesses.harness("opencode").remove();
    expect(harnesses.collection.has("opencode")).toBe(true);
  });
});

describe("views over the rows", () => {
  it("offer no built-in the install check didn't find, but report it", async () => {
    const proc: Proc = {
      runShellCommand: vi.fn(async () => ({ stdout: "", exitCode: 0 })),
    };
    const harnesses = testHarnesses({ proc });
    await harnesses.rescan();
    expect(pickableHarnesses(rowsOf(harnesses))).toEqual([]);
    expect(
      probedHarnesses(rowsOf(harnesses)).find(
        (probed) => probed.harness.id === "devin",
      )?.availability,
    ).toBe("missing");
  });

  it("are the built-ins, stock, before any row exists", () => {
    expect(pickableHarnesses([]).map((h) => h.id)).toEqual(
      BUILT_IN_HARNESSES.map((h) => h.id),
    );
  });
});

describe("a harness's usage reporting", () => {
  it("knows what the built-ins report, and believes the data over the table", () => {
    const harnesses = testHarnesses();
    const reporting = (id: string, seen?: { cost?: boolean; limits?: boolean }) =>
      harnesses.harness(id).reporting(seen);
    expect(reporting("claude-code")).toEqual({ cost: true, limits: true });
    expect(reporting("opencode")).toEqual({ cost: true, limits: false });
    expect(reporting("devin")).toEqual({ cost: false, limits: false });
    expect(reporting("gemini-cli")).toEqual({ cost: false, limits: false });
    expect(reporting("custom:1", { cost: true })).toEqual({ cost: true, limits: false });
    expect(reporting("devin", { limits: true })).toEqual({ cost: false, limits: true });
  });

  it("declares nothing for a custom harness, whichever built-in's tools it borrows", async () => {
    const harnesses = testHarnesses();
    const lab = harnesses.harness("custom:lab");
    await lab.saveCustom(customEntry({ mcpRegistrationOverride: "session-new" }));
    expect(lab.reporting()).toEqual({ cost: false, limits: false });
    expect(lab.reporting({ cost: true })).toEqual({ cost: true, limits: false });
  });

  it("still knows a built-in switched off", async () => {
    const { harnesses } = await withLegacySettings({
      overrides: { "claude-code": { id: "claude-code", enabled: false } },
    });
    expect(harnesses.harness("claude-code").reporting()).toEqual({ cost: true, limits: true });
  });
});
