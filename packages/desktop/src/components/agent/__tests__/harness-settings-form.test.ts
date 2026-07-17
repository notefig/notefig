import { describe, it, expect, vi } from "vitest";

vi.mock("@/adapters", () => ({ platformAdapter: {} }));

import {
  definitionToForm,
  deriveHarnessSettingsRows,
  formToCustomEntry,
  formToOverride,
  newCustomHarnessId,
  parseArgLines,
  parseEnvLines,
  toggleCustomEnabled,
  toggleOverrideEnabled,
  validateHarnessForm,
  type HarnessFormState,
} from "../harness-settings-form";
import { BUILT_IN_HARNESSES } from "@metrists/shared/agent";
import type {
  CustomHarnessEntry,
  HarnessOverride,
} from "@metrists/shared/agent";

const opencode = BUILT_IN_HARNESSES.find((h) => h.id === "opencode")!;
const claude = BUILT_IN_HARNESSES.find((h) => h.id === "claude-code")!;

function form(partial: Partial<HarnessFormState> = {}): HarnessFormState {
  return {
    label: "",
    command: "",
    argsText: "",
    envText: "",
    probeCommand: "",
    mcpOptIn: "none",
    ...partial,
  };
}

function customEntry(partial: Partial<CustomHarnessEntry> = {}): CustomHarnessEntry {
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

describe("parseArgLines", () => {
  it("one arg per line, trims CR, drops blanks, keeps spaces within a line", () => {
    expect(parseArgLines("acp\r\n\n  --cwd ${workspace}  \n")).toEqual([
      "acp",
      "--cwd ${workspace}",
    ]);
  });
});

describe("parseEnvLines", () => {
  it("splits on the FIRST =, preserving = in values; KEY= is legal", () => {
    const { env, errors } = parseEnvLines("A=x=y\nB=\nC=plain");
    expect(errors).toEqual([]);
    expect(env).toEqual({ A: "x=y", B: "", C: "plain" });
  });

  it("reports =-less, bad-key, and duplicate lines with line numbers", () => {
    const { errors } = parseEnvLines(
      "GOOD=1\nnoequals\n2BAD=x\nBAD KEY=x\nGOOD=again",
    );
    expect(errors).toEqual([
      { line: 2, kind: "no-equals" },
      { line: 3, kind: "bad-key" },
      { line: 4, kind: "bad-key" },
      { line: 5, kind: "duplicate" },
    ]);
  });

  it("ignores blank lines", () => {
    expect(parseEnvLines("\n\nA=1\n\n").errors).toEqual([]);
  });
});

describe("validateHarnessForm", () => {
  it("requires command always, label only when asked", () => {
    const empty = form();
    expect(
      validateHarnessForm(empty, { requireLabel: false }).errors.command,
    ).toBe("required");
    expect(
      validateHarnessForm(empty, { requireLabel: true }).errors.label,
    ).toBe("required");
    expect(
      validateHarnessForm(empty, { requireLabel: false }).errors.label,
    ).toBeUndefined();
  });

  it("valid form yields parsed values", () => {
    const { parsed, errors } = validateHarnessForm(
      form({ command: " ocv ", argsText: "acp", envText: "K=v" }),
      { requireLabel: false },
    );
    expect(errors).toEqual({});
    expect(parsed).toEqual({
      label: "",
      command: "ocv",
      args: ["acp"],
      env: { K: "v" },
      probeCommand: "",
    });
  });

  it("env errors block parsing", () => {
    const { parsed, errors } = validateHarnessForm(
      form({ command: "x", envText: "bad line" }),
      { requireLabel: false },
    );
    expect(parsed).toBeUndefined();
    expect(errors.env).toHaveLength(1);
  });
});

describe("definitionToForm / formToOverride round-trip (diff-on-save)", () => {
  function saveUntouched(def: typeof opencode) {
    const seeded = definitionToForm(def);
    const { parsed } = validateHarnessForm(seeded, { requireLabel: false });
    return formToOverride(parsed!, def, true, true);
  }

  it("seeding from a built-in and saving untouched produces NO override", () => {
    expect(saveUntouched(opencode)).toBeNull();
    expect(saveUntouched(claude)).toBeNull(); // incl. probeCommand equality
  });

  it("editing only the command produces an override with only command", () => {
    const seeded = definitionToForm(opencode);
    const { parsed } = validateHarnessForm(
      { ...seeded, command: "ocv" },
      { requireLabel: false },
    );
    expect(formToOverride(parsed!, opencode, true, true)).toEqual({
      id: "opencode",
      enabled: true,
      command: "ocv",
    });
  });

  it("editing a field back to the default drops it from the override", () => {
    const seeded = definitionToForm(opencode);
    const { parsed } = validateHarnessForm(
      { ...seeded, command: opencode.command },
      { requireLabel: false },
    );
    expect(formToOverride(parsed!, opencode, true, true)).toBeNull();
  });

  it("a disable that departs from the natural state keeps a row", () => {
    const seeded = definitionToForm(opencode);
    const { parsed } = validateHarnessForm(seeded, { requireLabel: false });
    expect(formToOverride(parsed!, opencode, false, true)).toEqual({
      id: "opencode",
      enabled: false,
    });
  });

  it("an enabled state matching the natural default leaves no row", () => {
    const seeded = definitionToForm(opencode);
    const { parsed } = validateHarnessForm(seeded, { requireLabel: false });
    // Not-found harness saved while off: off IS its natural state.
    expect(formToOverride(parsed!, opencode, false, false)).toBeNull();
    // Explicitly re-enabling a not-found harness needs a row.
    expect(formToOverride(parsed!, opencode, true, false)).toEqual({
      id: "opencode",
      enabled: true,
    });
  });

  it("an emptied probe field means inherit (omitted)", () => {
    const seeded = definitionToForm(claude);
    const { parsed } = validateHarnessForm(
      { ...seeded, probeCommand: "" },
      { requireLabel: false },
    );
    expect(formToOverride(parsed!, claude, true, true)).toBeNull();
  });
});

describe("formToCustomEntry", () => {
  it("builds a valid entry with the MCP opt-in and generated id", () => {
    const f = form({
      label: "Mine",
      command: "my-bin",
      argsText: "serve",
      mcpOptIn: "session-new",
    });
    const { parsed } = validateHarnessForm(f, { requireLabel: true });
    const id = newCustomHarnessId();
    expect(id).toMatch(/^custom:[0-9a-f-]{36}$/);
    expect(formToCustomEntry(parsed!, f, id, true)).toEqual({
      id,
      label: "Mine",
      command: "my-bin",
      args: ["serve"],
      env: {},
      mcpRegistrationOverride: "session-new",
      enabled: true,
    });
  });
});

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
      "custom:1": { harnessId: "custom:1", found: true, resolvedPath: "/x", probedAt: 0 },
    });
    const row = rows.find((r) => r.definition.id === "custom:1")!;
    expect(row.origin).toBe("custom");
    expect(row.discovery?.resolvedPath).toBe("/x");
    expect(
      rows.find((r) => r.definition.id === "claude-code")!.origin,
    ).toBe("builtin");
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
    expect(rows.find((r) => r.definition.id === "opencode")!.definition.command).toBe("ocv");
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
    expect(
      toggleOverrideEnabled(pinnedOn, "gemini-cli", false, false),
    ).toEqual({});
    // No row + natural state = still no row.
    expect(toggleOverrideEnabled({}, "opencode", true, true)).toEqual({});
  });

  it("toggleCustomEnabled updates immutably", () => {
    const entries = [customEntry(), customEntry({ id: "custom:2" })];
    const next = toggleCustomEnabled(entries, "custom:2", false);
    expect(next[1].enabled).toBe(false);
    expect(next[0].enabled).toBe(true);
    expect(entries[1].enabled).toBe(true);
  });
});
