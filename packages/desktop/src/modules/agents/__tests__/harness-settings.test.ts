import { describe, it, expect } from "vitest";
import {
  BUILT_IN_HARNESSES,
  type CustomHarnessEntry,
  type HarnessOverride,
} from "@notefig/shared/agent";
import {
  deriveHarnessSettingsRows,
  toggleOverrideEnabled,
} from "../harness-settings";

function customEntry(
  partial: Partial<CustomHarnessEntry> = {},
): CustomHarnessEntry {
  return {
    id: "custom:1",
    label: "L",
    command: "bin",
    args: [],
    env: {},
    mcpRegistrationOverride: "none",
    enabled: true,
    ...partial,
  };
}

describe("deriveHarnessSettingsRows", () => {
  it("includes disabled built-ins (the pickers hide them; settings must not)", () => {
    const overrides: Record<string, HarnessOverride> = {
      opencode: { id: "opencode", enabled: false },
    };
    const rows = deriveHarnessSettingsRows(overrides, [], {});
    const row = rows.find((r) => r.definition.id === "opencode")!;
    expect(row.enabled).toBe(false);
    // Enabled-only row = the switch, not a customization.
    expect(row.origin).toBe("builtin");
    expect(rows).toHaveLength(BUILT_IN_HARNESSES.length);
  });

  it("marks a row overridden only when the override is material", () => {
    const rows = deriveHarnessSettingsRows(
      {
        opencode: { id: "opencode", enabled: true, command: "ocv" },
        "gemini-cli": { id: "gemini-cli", enabled: true },
      },
      [],
      {},
    );
    expect(rows.find((r) => r.definition.id === "opencode")!.origin).toBe(
      "overridden",
    );
    expect(rows.find((r) => r.definition.id === "gemini-cli")!.origin).toBe(
      "builtin",
    );
  });

  it("annotates origin and discovery per row", () => {
    const rows = deriveHarnessSettingsRows({}, [customEntry()], {
      "custom:1": {
        harnessId: "custom:1",
        found: true,
        resolvedPath: "/x",
        probedAt: 0,
      },
    });
    const row = rows.find((r) => r.definition.id === "custom:1")!;
    expect(row.origin).toBe("custom");
    expect(row.discovery?.resolvedPath).toBe("/x");
    expect(rows.find((r) => r.definition.id === "claude-code")!.origin).toBe(
      "builtin",
    );
  });

  it("defaults a not-found built-in to OFF when no explicit setting exists", () => {
    const rows = deriveHarnessSettingsRows({}, [], {
      "gemini-cli": { harnessId: "gemini-cli", found: false, probedAt: 0 },
      opencode: {
        harnessId: "opencode",
        found: true,
        resolvedPath: "/x",
        probedAt: 0,
      },
    });
    expect(rows.find((r) => r.definition.id === "gemini-cli")!.enabled).toBe(
      false,
    );
    expect(rows.find((r) => r.definition.id === "opencode")!.enabled).toBe(
      true,
    );
    // No discovery data (scan never ran) → stays enabled.
    expect(rows.find((r) => r.definition.id === "claude-code")!.enabled).toBe(
      true,
    );
  });

  it("an explicit enabled override beats the not-found default", () => {
    const rows = deriveHarnessSettingsRows(
      { "gemini-cli": { id: "gemini-cli", enabled: true } },
      [],
      { "gemini-cli": { harnessId: "gemini-cli", found: false, probedAt: 0 } },
    );
    expect(rows.find((r) => r.definition.id === "gemini-cli")!.enabled).toBe(
      true,
    );
  });

  it("shows a disabled custom entry with merged override commands intact", () => {
    const rows = deriveHarnessSettingsRows(
      { opencode: { id: "opencode", enabled: true, command: "ocv" } },
      [customEntry({ enabled: false })],
      {},
    );
    expect(
      rows.find((r) => r.definition.id === "opencode")!.definition.command,
    ).toBe("ocv");
    const custom = rows.find((r) => r.definition.id === "custom:1")!;
    expect(custom.enabled).toBe(false);
  });
});

describe("toggle helpers", () => {
  it("toggleOverrideEnabled creates the row when departing from natural, preserves fields", () => {
    expect(toggleOverrideEnabled({}, "opencode", false, true)).toEqual({
      opencode: { id: "opencode", enabled: false },
    });
    const withCommand: Record<string, HarnessOverride> = {
      opencode: { id: "opencode", enabled: false, command: "ocv" },
    };
    expect(toggleOverrideEnabled(withCommand, "opencode", true, true)).toEqual({
      opencode: { id: "opencode", enabled: true, command: "ocv" },
    });
  });

  it("re-enabling a stock harness removes its row instead of keeping it", () => {
    const disabled: Record<string, HarnessOverride> = {
      opencode: { id: "opencode", enabled: false },
    };
    expect(toggleOverrideEnabled(disabled, "opencode", true, true)).toEqual({});
    // Disabling a not-found harness back to its natural off also cleans up.
    const pinnedOn: Record<string, HarnessOverride> = {
      "gemini-cli": { id: "gemini-cli", enabled: true },
    };
    expect(toggleOverrideEnabled(pinnedOn, "gemini-cli", false, false)).toEqual(
      {},
    );
    // No row + natural state = still no row.
    expect(toggleOverrideEnabled({}, "opencode", true, true)).toEqual({});
  });
});
