import {
  BUILT_IN_HARNESSES,
  NESTED_SESSION_GUARD_VARS,
  composeHarnessEnv,
  resolveHarness,
  type CustomHarnessEntry,
} from "./harness-config";

const builtin = BUILT_IN_HARNESSES[0];

const customEntry = {
  id: "my-agent",
  label: "My agent",
  command: "/opt/my-agent",
  args: [],
  env: {},
  mcpRegistrationOverride: "none",
} as unknown as CustomHarnessEntry;

describe("resolveHarness", () => {
  it("returns the built-in when there are no settings", () => {
    const resolved = resolveHarness(builtin.id);
    expect(resolved).toEqual({ ok: true, harness: builtin });
  });

  it("applies an override to the built-in", () => {
    const resolved = resolveHarness(builtin.id, {
      [builtin.id]: { id: builtin.id, enabled: true, command: "/custom/bin" },
    });
    expect(resolved.ok && resolved.harness.command).toBe("/custom/bin");
  });

  it("reports a disabled built-in as disabled, not unknown", () => {
    const resolved = resolveHarness(builtin.id, {
      [builtin.id]: { id: builtin.id, enabled: false },
    });
    expect(resolved).toMatchObject({ ok: false, reason: "disabled" });
    expect(!resolved.ok && resolved.available).not.toContain(builtin.id);
  });

  it("finds an enabled custom harness", () => {
    const resolved = resolveHarness("my-agent", {}, [customEntry]);
    expect(resolved.ok && resolved.harness.command).toBe("/opt/my-agent");
  });

  it("reports a disabled custom harness as disabled", () => {
    const resolved = resolveHarness("my-agent", {}, [
      { ...customEntry, enabled: false },
    ]);
    expect(resolved).toMatchObject({ ok: false, reason: "disabled" });
  });

  it("reports an id nobody defines as unknown, with what is available", () => {
    const resolved = resolveHarness("nope");
    expect(resolved).toMatchObject({ ok: false, reason: "unknown" });
    expect(!resolved.ok && resolved.available).toEqual(
      BUILT_IN_HARNESSES.map((h) => h.id),
    );
  });
});

describe("composeHarnessEnv", () => {
  it("layers host env, then harness env, then task env", () => {
    const env = composeHarnessEnv(
      { A: "host", B: "host", C: "host" },
      { env: { B: "harness", C: "harness" } },
      { C: "task" },
    );
    expect(env).toMatchObject({ A: "host", B: "harness", C: "task" });
  });

  it("strips every nested-session guard var, wherever it came from", () => {
    const guards = Object.fromEntries(
      NESTED_SESSION_GUARD_VARS.map((name) => [name, "1"]),
    );
    const env = composeHarnessEnv(guards, { env: guards }, guards);
    for (const name of NESTED_SESSION_GUARD_VARS) {
      expect(env).not.toHaveProperty(name);
    }
  });
});
