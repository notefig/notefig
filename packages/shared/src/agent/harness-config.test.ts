import {
  BUILT_IN_HARNESSES,
  filterDiscoveredHarnesses,
  resolveEffectiveHarnesses,
} from "./harness-config";
import type {
  CustomHarnessEntry,
  HarnessDiscoveryResult,
  HarnessOverride,
} from "./harness-config";

const CLAUDE_CODE_ID = "claude-code";

function discovered(
  id: string,
  found: boolean,
): Record<string, HarnessDiscoveryResult> {
  return { [id]: { harnessId: id, found, probedAt: 0 } };
}

describe("resolveEffectiveHarnesses", () => {
  it("returns built-ins unchanged with no overrides or custom entries", () => {
    expect(resolveEffectiveHarnesses({}, [])).toEqual(BUILT_IN_HARNESSES);
  });

  it("merges env over the built-in without touching command/args", () => {
    const overrides: Record<string, HarnessOverride> = {
      [CLAUDE_CODE_ID]: {
        id: CLAUDE_CODE_ID,
        enabled: true,
        env: { CLAUDE_CODE_USE_VERTEX: "1" },
      },
    };
    const result = resolveEffectiveHarnesses(overrides, []);
    const claude = result.find((h) => h.id === CLAUDE_CODE_ID)!;
    const builtin = BUILT_IN_HARNESSES.find((h) => h.id === CLAUDE_CODE_ID)!;
    expect(claude.command).toBe(builtin.command);
    expect(claude.args).toEqual(builtin.args);
    expect(claude.env).toEqual({ CLAUDE_CODE_USE_VERTEX: "1" });
  });

  it("replaces (not merges) args when an override provides them", () => {
    const overrides: Record<string, HarnessOverride> = {
      [CLAUDE_CODE_ID]: { id: CLAUDE_CODE_ID, enabled: true, args: ["--foo"] },
    };
    const result = resolveEffectiveHarnesses(overrides, []);
    expect(result.find((h) => h.id === CLAUDE_CODE_ID)!.args).toEqual([
      "--foo",
    ]);
  });

  it("overrides the command (the ocv scenario)", () => {
    const overrides: Record<string, HarnessOverride> = {
      opencode: { id: "opencode", enabled: true, command: "ocv" },
    };
    const result = resolveEffectiveHarnesses(overrides, []);
    expect(result.find((h) => h.id === "opencode")!.command).toBe("ocv");
  });

  it("drops a harness disabled via override", () => {
    const overrides: Record<string, HarnessOverride> = {
      [CLAUDE_CODE_ID]: { id: CLAUDE_CODE_ID, enabled: false },
    };
    const result = resolveEffectiveHarnesses(overrides, []);
    expect(result.find((h) => h.id === CLAUDE_CODE_ID)).toBeUndefined();
    expect(result).toHaveLength(BUILT_IN_HARNESSES.length - 1);
  });

  it("appends a custom entry with the default mcpRegistration", () => {
    const custom: CustomHarnessEntry[] = [
      {
        id: "custom:1",
        label: "My Harness",
        command: "my-harness",
        args: [],
        env: {},
        mcpRegistrationOverride: "none",
        enabled: true,
      },
    ];
    const result = resolveEffectiveHarnesses({}, custom);
    const entry = result.find((h) => h.id === "custom:1")!;
    expect(entry.mcpRegistration).toBe("none");
  });

  it("honors an explicit mcpRegistration opt-in on a custom entry", () => {
    const custom: CustomHarnessEntry[] = [
      {
        id: "custom:2",
        label: "My Harness",
        command: "my-harness",
        args: [],
        env: {},
        mcpRegistrationOverride: "session-new",
        enabled: true,
      },
    ];
    const result = resolveEffectiveHarnesses({}, custom);
    expect(result.find((h) => h.id === "custom:2")!.mcpRegistration).toBe(
      "session-new",
    );
  });

  it("inherits the built-in probeCommand unless the override sets one", () => {
    const inherited = resolveEffectiveHarnesses(
      { [CLAUDE_CODE_ID]: { id: CLAUDE_CODE_ID, enabled: true, command: "/opt/acp" } },
      [],
    ).find((h) => h.id === CLAUDE_CODE_ID)!;
    expect(inherited.probeCommand).toBe("command -v claude");

    const overridden = resolveEffectiveHarnesses(
      {
        [CLAUDE_CODE_ID]: {
          id: CLAUDE_CODE_ID,
          enabled: true,
          probeCommand: "command -v my-claude",
        },
      },
      [],
    ).find((h) => h.id === CLAUDE_CODE_ID)!;
    expect(overridden.probeCommand).toBe("command -v my-claude");
  });

  it("excludes a disabled custom entry", () => {
    const custom: CustomHarnessEntry[] = [
      {
        id: "custom:3",
        label: "My Harness",
        command: "my-harness",
        args: [],
        env: {},
        mcpRegistrationOverride: "none",
        enabled: false,
      },
    ];
    const result = resolveEffectiveHarnesses({}, custom);
    expect(result.find((h) => h.id === "custom:3")).toBeUndefined();
  });
});

describe("filterDiscoveredHarnesses", () => {
  it("hides a built-in that discovery affirmatively did not find", () => {
    const visible = filterDiscoveredHarnesses(
      BUILT_IN_HARNESSES,
      {},
      [],
      discovered("gemini-cli", false),
    );
    expect(visible.find((h) => h.id === "gemini-cli")).toBeUndefined();
    expect(visible).toHaveLength(BUILT_IN_HARNESSES.length - 1);
  });

  it("keeps entries with no discovery data (scan never ran)", () => {
    expect(filterDiscoveredHarnesses(BUILT_IN_HARNESSES, {}, [], {})).toEqual(
      BUILT_IN_HARNESSES,
    );
  });

  it("keeps a found built-in", () => {
    const visible = filterDiscoveredHarnesses(
      BUILT_IN_HARNESSES,
      {},
      [],
      discovered("opencode", true),
    );
    expect(visible.find((h) => h.id === "opencode")).toBeDefined();
  });

  it("always keeps materially overridden entries — the user knows better than the probe", () => {
    const overrides: Record<string, HarnessOverride> = {
      opencode: { id: "opencode", enabled: true, command: "ocv" },
    };
    const visible = filterDiscoveredHarnesses(
      resolveEffectiveHarnesses(overrides, []),
      overrides,
      [],
      discovered("opencode", false),
    );
    expect(visible.find((h) => h.id === "opencode")).toBeDefined();
  });

  it("an enabled-only override does NOT exempt a not-found harness", () => {
    const overrides: Record<string, HarnessOverride> = {
      "gemini-cli": { id: "gemini-cli", enabled: true },
    };
    const visible = filterDiscoveredHarnesses(
      resolveEffectiveHarnesses(overrides, []),
      overrides,
      [],
      discovered("gemini-cli", false),
    );
    expect(visible.find((h) => h.id === "gemini-cli")).toBeUndefined();
  });

  it("always keeps custom entries", () => {
    const custom: CustomHarnessEntry[] = [
      {
        id: "custom:1",
        label: "L",
        command: "custom-bin",
        args: [],
        env: {},
        mcpRegistrationOverride: "none",
        enabled: true,
      },
    ];
    const visible = filterDiscoveredHarnesses(
      resolveEffectiveHarnesses({}, custom),
      {},
      custom,
      discovered("custom:1", false),
    );
    expect(visible.find((h) => h.id === "custom:1")).toBeDefined();
  });
});
