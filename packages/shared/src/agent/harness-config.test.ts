import {
  BUILT_IN_HARNESSES,
  buildHarnessResumeCommand,
  describeProbedHarnesses,
  filterDiscoveredHarnesses,
  isMaterialOverride,
  resolveEffectiveHarnesses,
} from "./harness-config";
import type {
  CustomHarnessEntry,
  HarnessDiscoveryResult,
  HarnessOverride,
} from "./harness-config";

const CLAUDE_CODE_ID = "claude-code";
const claude = BUILT_IN_HARNESSES.find((h) => h.id === CLAUDE_CODE_ID)!;

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
      {
        [CLAUDE_CODE_ID]: {
          id: CLAUDE_CODE_ID,
          enabled: true,
          command: "/opt/acp",
        },
      },
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

  it("inherits the built-in resumeCommand unless the override sets one", () => {
    const inherited = resolveEffectiveHarnesses(
      { [CLAUDE_CODE_ID]: { id: CLAUDE_CODE_ID, enabled: true, command: "c" } },
      [],
    ).find((h) => h.id === CLAUDE_CODE_ID)!;
    expect(inherited.resumeCommand).toBe(claude.resumeCommand);

    const overrides: Record<string, HarnessOverride> = {
      [CLAUDE_CODE_ID]: {
        id: CLAUDE_CODE_ID,
        enabled: true,
        resumeCommand: "claude -r ${sessionId}",
      },
    };
    const overridden = resolveEffectiveHarnesses(overrides, []).find(
      (h) => h.id === CLAUDE_CODE_ID,
    )!;
    expect(overridden.resumeCommand).toBe("claude -r ${sessionId}");
    // A resume-only override is material (settings badge + save keeps it).
    expect(isMaterialOverride(overrides[CLAUDE_CODE_ID])).toBe(true);
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

describe("describeProbedHarnesses", () => {
  it("keeps every harness, unlike the picker's filter", () => {
    const rows = describeProbedHarnesses(
      {},
      [],
      discovered(CLAUDE_CODE_ID, false),
    );
    expect(rows).toHaveLength(BUILT_IN_HARNESSES.length);
  });

  it("labels found, missing and unchecked distinctly", () => {
    const rows = describeProbedHarnesses(
      {},
      [],
      discovered(CLAUDE_CODE_ID, true),
    );
    const claudeRow = rows.find((r) => r.harness.id === CLAUDE_CODE_ID)!;
    expect(claudeRow.availability).toBe("found");
    // Every other built-in has no row in the discovery map at all: that is
    // "we never checked", which must not be reported as "not installed".
    for (const row of rows.filter((r) => r.harness.id !== CLAUDE_CODE_ID)) {
      expect(row.availability).toBe("unknown");
    }
    expect(
      describeProbedHarnesses({}, [], discovered(CLAUDE_CODE_ID, false)).find(
        (r) => r.harness.id === CLAUDE_CODE_ID,
      )!.availability,
    ).toBe("missing");
  });

  it("reports no verdict when discovery has never run", () => {
    for (const row of describeProbedHarnesses({}, [], {})) {
      expect(row.availability).toBe("unknown");
      expect(row.probedAt).toBeUndefined();
    }
  });

  it("carries the probe's resolved path and timestamp through", () => {
    const rows = describeProbedHarnesses({}, [], {
      [CLAUDE_CODE_ID]: {
        harnessId: CLAUDE_CODE_ID,
        found: true,
        resolvedPath: "/usr/local/bin/claude",
        probedAt: 1234,
      },
    });
    const row = rows.find((r) => r.harness.id === CLAUDE_CODE_ID)!;
    expect(row.resolvedPath).toBe("/usr/local/bin/claude");
    expect(row.probedAt).toBe(1234);
  });

  it("reports the probe verdict for a customized harness rather than exempting it", () => {
    // filterDiscoveredHarnesses deliberately keeps customized entries
    // visible whatever the probe said. A readiness list has the opposite
    // duty: candidateProbeEntries probes the OVERRIDE's command, so the
    // verdict is about the binary the user actually pointed at.
    const overrides: Record<string, HarnessOverride> = {
      [CLAUDE_CODE_ID]: {
        id: CLAUDE_CODE_ID,
        enabled: true,
        command: "/opt/custom/claude",
      },
    };
    const row = describeProbedHarnesses(
      overrides,
      [],
      discovered(CLAUDE_CODE_ID, false),
    ).find((r) => r.harness.id === CLAUDE_CODE_ID)!;
    expect(row.harness.command).toBe("/opt/custom/claude");
    expect(row.availability).toBe("missing");
  });

  it("includes enabled custom entries and drops disabled ones", () => {
    const custom: CustomHarnessEntry[] = [
      {
        id: "mine",
        label: "Mine",
        command: "mine",
        args: [],
        env: {},
        mcpRegistrationOverride: "none",
        enabled: true,
      },
      {
        id: "off",
        label: "Off",
        command: "off",
        args: [],
        env: {},
        mcpRegistrationOverride: "none",
        enabled: false,
      },
    ];
    const ids = describeProbedHarnesses({}, custom, {}).map(
      (r) => r.harness.id,
    );
    expect(ids).toContain("mine");
    expect(ids).not.toContain("off");
  });
});

describe("buildHarnessResumeCommand", () => {
  const params = {
    sessionId: "sess-123",
    workspacePath: "/Users/x/My Notes",
  };

  it("substitutes sessionId and workspace as shell-quoted arguments", () => {
    expect(buildHarnessResumeCommand(claude, params)).toBe(
      "cd '/Users/x/My Notes' && claude --resume sess-123",
    );
  });

  it("renders the powershell dialect: PS quoting, `;` sequencing, native paths (MET-157)", () => {
    const command = buildHarnessResumeCommand(
      claude,
      {
        sessionId: "sess-123",
        workspacePath: "C:\\Users\\x\\My Notes",
      },
      "powershell",
    );
    // Single quotes are literal in PowerShell; embedded quotes double; `&&`
    // is not a Windows PowerShell 5.1 operator, `;` is.
    expect(command).toBe(
      "cd 'C:\\Users\\x\\My Notes'; claude --resume sess-123",
    );
  });

  it("powershell quoting doubles embedded single quotes", () => {
    const command = buildHarnessResumeCommand(
      claude,
      {
        sessionId: "sess-123",
        workspacePath: "C:\\it's",
      },
      "powershell",
    );
    expect(command).toBe("cd 'C:\\it''s'; claude --resume sess-123");
  });

  it("neutralizes shell metacharacters in substituted values", () => {
    const command = buildHarnessResumeCommand(claude, {
      sessionId: "sess-123",
      workspacePath: "/tmp/$(rm -rf ~)/it's",
    });
    expect(command).toBe(
      "cd '/tmp/$(rm -rf ~)/it'\\''s' && claude --resume sess-123",
    );
  });

  it("strips author quoting around placeholders — our quoting is the only quoting", () => {
    const quoted = {
      ...claude,
      resumeCommand: "cd \"${workspace}\" && claude --resume '${sessionId}'",
    };
    expect(
      buildHarnessResumeCommand(quoted, {
        sessionId: "sess-123",
        workspacePath: "/tmp/$(whoami)",
      }),
    ).toBe("cd '/tmp/$(whoami)' && claude --resume sess-123");
  });

  it("returns null when the harness declares no resumeCommand", () => {
    const gemini = BUILT_IN_HARNESSES.find((h) => h.id === "gemini-cli")!;
    expect(gemini.resumeCommand).toBeUndefined();
    expect(buildHarnessResumeCommand(gemini, params)).toBeNull();
  });
});
