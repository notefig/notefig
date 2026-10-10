import {
  NO_PREP,
  isStdioMcpServer,
  type HarnessAdapter,
  type StdioMcpServer,
} from "./adapter";

/**
 * OpenCode (`opencode acp`).
 *
 * "opencode-config": inject the server as `OPENCODE_CONFIG_CONTENT` —
 * inline JSON OpenCode merges last, on top of the user's own global /
 * `OPENCODE_CONFIG` / project configs (merge order verified against
 * opencode 1.18.15, MET-65). A value instead of a file: nothing lands in
 * the workspace, nothing to clean up, and browser transports carry it as
 * plain env (the embedded relay command is already worker-local, so no
 * path rewriting).
 */
export const openCodeAdapter: HarnessAdapter = {
  onInvoke: async ({ mcpServer, harnessEnv }) => {
    if (!isStdioMcpServer(mcpServer)) return NO_PREP;
    const config = deepMergeConfigs(
      parseConfigObject(harnessEnv.OPENCODE_CONFIG_CONTENT),
      {
        $schema: "https://opencode.ai/config.json",
        mcp: {
          [mcpServer.name]: {
            type: "local",
            command: [mcpServer.command, ...mcpServer.args],
            enabled: true,
            environment: envRecord(mcpServer),
          },
        },
      },
    );
    return {
      ...NO_PREP,
      env: { OPENCODE_CONFIG_CONTENT: JSON.stringify(config) },
    };
  },
  // Cost on `usage_update`; no account limits.
  reporting: { cost: true, limits: false },
};

/** The ACP env list as a plain record, the shape config files want. */
function envRecord(server: StdioMcpServer): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const entry of server.env ?? []) environment[entry.name] = entry.value;
  return environment;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A harness env override may carry its own config content; ours layers on
 *  top rather than clobbering it. Unparseable content degrades to `{}` —
 *  the harness itself would reject it too. */
function parseConfigObject(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Layer `overlay` onto `base` with OpenCode's own config-merge semantics
 * (`mergeConfigConcatArrays`): objects merge recursively, arrays concatenate,
 * scalars from the overlay win — so neither side's nested keys (e.g. the
 * `mcp` map) clobber the other's.
 */
function deepMergeConfigs(
  base: Record<string, unknown>,
  overlay: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    const existing = merged[key];
    if (isPlainObject(existing) && isPlainObject(value)) {
      merged[key] = deepMergeConfigs(existing, value);
    } else if (Array.isArray(existing) && Array.isArray(value)) {
      merged[key] = [...existing, ...value];
    } else {
      merged[key] = value;
    }
  }
  return merged;
}
