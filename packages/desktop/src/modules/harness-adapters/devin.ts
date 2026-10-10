import {
  NO_PREP,
  NO_REPORTING,
  isStdioMcpServer,
  type HarnessAdapter,
} from "./adapter";

/** Args are positional and unnamed, so they're forwarded by index; env
 *  entries keep their own names on both sides of the hop. */
const DEVIN_ARG_VAR_PREFIX = "NOTEFIG_MCP_ARG_";

/** Devin's project config file, under the host-supplied app dir. */
const DEVIN_CONFIG_SEGMENTS = [".devin", "mcp_config.local.json"];

/**
 * Devin (`devin acp`).
 *
 * "devin-config": devin reads MCP servers only from config files — there is
 * no inline-content env var, `--config` doesn't reach `mcp_config.json`, and
 * `session/new.mcpServers` is not dependable (it connected in one of seven
 * spike runs and never reproduced — devin-acp-mcp-spike.md). The MODEL's
 * tool set is assembled from the SESSION's config scopes (its cwd plus any
 * `additionalDirectories`) — a config merely discoverable from the process
 * cwd connects but never reaches the toolbox (verified 2026-09-11, logged-in
 * devin). So the file lives in the app dir and the session names that dir in
 * `additionalDirectories`, which both connects the server and puts its tools
 * in front of the model; the process spawns in the plain workspace.
 *
 * ONE file serves every devin session in the workspace: the per-task relay
 * port and token are `${env:...}` references devin expands from the spawn
 * env (verified for `command`, `args` and `env` values), so what lands on
 * disk is identical no matter which task wrote it and concurrent tasks
 * can't clobber each other's connection. The file is the app's alone — the
 * user's own `devin` walks up from the workspace and never descends into
 * the app dir — so it is written whole, with nothing of theirs to preserve
 * and nothing of ours to clean up.
 *
 * A file that can't be written is a missing tool set, not a failed task:
 * the harness still spawns, just without the app's tools.
 */
export const devinAdapter: HarnessAdapter = {
  onInvoke: async ({
    mcpServer,
    workspacePath,
    joinPath,
    appDir,
    writeFiles,
    warn,
  }) => {
    if (!isStdioMcpServer(mcpServer)) return NO_PREP;
    const document = {
      mcpServers: {
        [mcpServer.name]: {
          command: mcpServer.command,
          args: mcpServer.args.map(
            (_, index) => `\${env:${DEVIN_ARG_VAR_PREFIX}${index}}`,
          ),
          env: Object.fromEntries(
            (mcpServer.env ?? []).map((entry) => [
              entry.name,
              `\${env:${entry.name}}`,
            ]),
          ),
        },
      },
    };
    const written = await writeFiles([
      {
        path: joinPath(workspacePath, appDir, ...DEVIN_CONFIG_SEGMENTS),
        content: JSON.stringify(document, null, 2),
      },
    ]);
    if (written.failed.length > 0) {
      warn(
        "harness MCP config write failed; spawning without app tools",
        written.failed[0].message,
      );
      return NO_PREP;
    }
    const env: Record<string, string> = {};
    mcpServer.args.forEach((value, index) => {
      env[`${DEVIN_ARG_VAR_PREFIX}${index}`] = value;
    });
    for (const entry of mcpServer.env ?? []) env[entry.name] = entry.value;
    return {
      ...NO_PREP,
      env,
      sessionParams: {
        additionalDirectories: [joinPath(workspacePath, appDir)],
      },
    };
  },
  // Its cost is credits, not money, so it is charted apart.
  reporting: NO_REPORTING,
};
