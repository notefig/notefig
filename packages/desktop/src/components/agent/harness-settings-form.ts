import {
  BUILT_IN_HARNESSES,
  isMaterialOverride,
  type CustomHarnessEntry,
  type HarnessDefinition,
  type HarnessOverride,
} from "@notefig/shared/agent";

/**
 * Pure state/validation helpers for the harness settings section — no React.
 * The form shows the EFFECTIVE definition's real values (built-in defaults
 * merged with any override); inherit-vs-override is a diff on save
 * (`formToOverride`), so untouched fields keep inheriting and future
 * built-in default changes flow through.
 */

export type HarnessFormState = {
  /** Custom entries only; ignored for built-in overrides. */
  label: string;
  command: string;
  /** Textarea raw text, one argument per line. */
  argsText: string;
  /** Textarea raw text, KEY=VALUE per line. */
  envText: string;
  probeCommand: string;
  /** Terminal resume template (`${sessionId}`/`${workspace}`); empty = none
   *  (or inherit, for built-in overrides). */
  resumeCommand: string;
  /** Custom entries only: the warned MCP opt-in. */
  mcpOptIn: "none" | "session-new";
};

export type EnvLineError = {
  line: number;
  kind: "no-equals" | "bad-key" | "duplicate";
};

export type HarnessFormErrors = {
  label?: "required";
  command?: "required";
  env?: EnvLineError[];
};

export type ParsedHarnessForm = {
  label: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  probeCommand: string;
  resumeCommand: string;
};

/** One argv entry per non-blank line, verbatim (spaces stay in the arg). */
export function parseArgLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.replace(/\r$/, "").trim())
    .filter((line) => line.length > 0);
}

const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** KEY=VALUE per line, split on the FIRST `=` (values may contain `=`);
 *  `KEY=` (empty value) is legal. Errors carry 1-based line numbers. */
export function parseEnvLines(text: string): {
  env: Record<string, string>;
  errors: EnvLineError[];
} {
  const env: Record<string, string> = {};
  const errors: EnvLineError[] = [];
  text.split("\n").forEach((rawLine, index) => {
    const line = rawLine.replace(/\r$/, "").trim();
    if (line.length === 0) return;
    const eq = line.indexOf("=");
    if (eq === -1) {
      errors.push({ line: index + 1, kind: "no-equals" });
      return;
    }
    const key = line.slice(0, eq).trim();
    if (!ENV_KEY_PATTERN.test(key)) {
      errors.push({ line: index + 1, kind: "bad-key" });
      return;
    }
    if (key in env) {
      errors.push({ line: index + 1, kind: "duplicate" });
      return;
    }
    env[key] = line.slice(eq + 1);
  });
  return { env, errors };
}

/** Seed the form from the effective definition — real values, not
 *  placeholders (the user sees exactly what would spawn today). */
export function definitionToForm(
  definition: HarnessDefinition,
): HarnessFormState {
  return {
    label: definition.label,
    command: definition.command,
    argsText: definition.args.join("\n"),
    envText: Object.entries(definition.env)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n"),
    probeCommand: definition.probeCommand ?? "",
    resumeCommand: definition.resumeCommand ?? "",
    mcpOptIn: "none",
  };
}

export function validateHarnessForm(
  form: HarnessFormState,
  opts: { requireLabel: boolean },
): { errors: HarnessFormErrors; parsed?: ParsedHarnessForm } {
  const errors: HarnessFormErrors = {};
  if (opts.requireLabel && form.label.trim().length === 0) {
    errors.label = "required";
  }
  if (form.command.trim().length === 0) {
    errors.command = "required";
  }
  const { env, errors: envErrors } = parseEnvLines(form.envText);
  if (envErrors.length > 0) errors.env = envErrors;

  if (Object.keys(errors).length > 0) return { errors };
  return {
    errors,
    parsed: {
      label: form.label.trim(),
      command: form.command.trim(),
      args: parseArgLines(form.argsText),
      env,
      probeCommand: form.probeCommand.trim(),
      resumeCommand: form.resumeCommand.trim(),
    },
  };
}

function sameArgs(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((arg, i) => arg === b[i]);
}

function sameEnv(
  a: Record<string, string>,
  b: Record<string, string>,
): boolean {
  const aKeys = Object.keys(a);
  return (
    aKeys.length === Object.keys(b).length &&
    aKeys.every((key) => a[key] === b[key])
  );
}

/**
 * Diff-on-save: fields still equal to the built-in default are omitted from
 * the override, so they keep inheriting. Returns null — the caller deletes
 * the override row entirely — when nothing differs AND the enabled state
 * matches its natural default (found harnesses default on, not-found ones
 * off), so a fully-stock harness never keeps a lingering row that would
 * read as "customized".
 */
export function formToOverride(
  parsed: ParsedHarnessForm,
  builtin: HarnessDefinition,
  enabled: boolean,
  naturalEnabled: boolean,
): HarnessOverride | null {
  const override: HarnessOverride = { id: builtin.id, enabled };
  if (parsed.command !== builtin.command) override.command = parsed.command;
  if (!sameArgs(parsed.args, builtin.args)) override.args = parsed.args;
  if (!sameEnv(parsed.env, builtin.env)) override.env = parsed.env;
  const builtinProbe = builtin.probeCommand ?? "";
  if (parsed.probeCommand !== builtinProbe && parsed.probeCommand !== "") {
    override.probeCommand = parsed.probeCommand;
  }
  const builtinResume = builtin.resumeCommand ?? "";
  if (parsed.resumeCommand !== builtinResume && parsed.resumeCommand !== "") {
    override.resumeCommand = parsed.resumeCommand;
  }
  if (!isMaterialOverride(override) && enabled === naturalEnabled) return null;
  return override;
}

export function formToCustomEntry(
  parsed: ParsedHarnessForm,
  form: HarnessFormState,
  id: string,
  enabled: boolean,
): CustomHarnessEntry {
  return {
    id,
    label: parsed.label,
    command: parsed.command,
    args: parsed.args,
    env: parsed.env,
    ...(parsed.probeCommand ? { probeCommand: parsed.probeCommand } : {}),
    ...(parsed.resumeCommand ? { resumeCommand: parsed.resumeCommand } : {}),
    mcpRegistrationOverride: form.mcpOptIn,
    enabled,
  };
}

export function newCustomHarnessId(): string {
  return `custom:${crypto.randomUUID()}`;
}

export function isBuiltInHarness(id: string): boolean {
  return BUILT_IN_HARNESSES.some((harness) => harness.id === id);
}

export function builtInHarness(id: string): HarnessDefinition | undefined {
  return BUILT_IN_HARNESSES.find((harness) => harness.id === id);
}
