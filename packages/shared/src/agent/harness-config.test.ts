import { BUILT_IN_HARNESSES, resolveEffectiveHarnesses } from "./harness-config";
import type { CustomHarnessEntry, HarnessOverride } from "./harness-config";

const CLAUDE_CODE_ID = "claude-code";

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
