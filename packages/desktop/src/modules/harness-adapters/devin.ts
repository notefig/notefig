import {
  addTokens,
  type Cost,
  type PromptResponse,
  type TokenCounts,
} from "@notefig/shared/agent";
import {
  NO_PREP,
  NO_REPORTING,
  acpCostTotal,
  isStdioMcpServer,
  tokensFrom,
  type HarnessAdapter,
  type UsageReader,
  type UsageUpdate,
  type WithMeta,
} from "./adapter";

/** Args are positional and unnamed, so they're forwarded by index; env
 *  entries keep their own names on both sides of the hop. */
const DEVIN_ARG_VAR_PREFIX = "NOTEFIG_MCP_ARG_";

/** Devin's project config file, under the host-supplied app dir. */
const DEVIN_CONFIG_SEGMENTS = [".devin", "mcp_config.local.json"];

// ─── Usage ──────────────────────────────────────────────────────────────────
//
// Devin counts cache reads inside `inputTokens`. Its `PromptResponse.usage`
// is its last model request only: it sends one `usage_update` per request
// with that request's tokens in `_meta`, twice for the main agent (plain,
// then tagged `subagent_context: root`) and once, tagged with its own id, for
// each subagent request — so the turn is the sum of the tagged updates
// (acp-usage-multistep-spike.md). Its credits (`cognition.ai/totalCreditCost`)
// are a session-running total like others' money: its cost, typed "credits".

/** The unit Devin's `totalCreditCost` counts in. */
const DEVIN_CREDIT = "devin-credit";

function metaNumber(update: UsageUpdate, key: string): number | null {
  const value = (update._meta as Record<string, unknown> | null | undefined)?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** The agent a Devin update or chunk came from: `"root"` for the main
 *  agent, a subagent's id, or null for its plain copy of a main-agent
 *  update. Devin tags them only for a client that says it supports
 *  subagents. */
export function devinAgentOf(update: WithMeta): string | null {
  const context = update._meta?.["cognition.ai/subagent_context"] as
    | { parentAgentId?: unknown }
    | undefined;
  return typeof context?.parentAgentId === "string" ? context.parentAgentId : null;
}

/** Money where ACP's `cost` is sent, else Devin's running credit total. */
function devinCostTotal(update: UsageUpdate): Cost | null {
  const money = acpCostTotal(update);
  if (money) return money;
  const credits = metaNumber(update, "cognition.ai/totalCreditCost");
  return credits === null
    ? null
    : { amount: credits, currency: DEVIN_CREDIT, type: "credits" };
}

/** Devin's per-request tokens, summed over the turn's tagged updates; null
 *  when the turn has none (a Devin that sends plain copies only), so the
 *  response stands. */
function devinRequestTokens(updates: readonly UsageUpdate[]): TokenCounts | null {
  let sum: TokenCounts | null = null;
  for (const update of updates) {
    if (devinAgentOf(update) === null) continue;
    const input = metaNumber(update, "cognition.ai/inputTokens");
    if (input === null) continue;
    const tokens = tokensFrom(
      {
        inputTokens: input,
        outputTokens: metaNumber(update, "cognition.ai/outputTokens") ?? 0,
        cachedReadTokens: metaNumber(update, "cognition.ai/cachedReadTokens"),
        cachedWriteTokens: metaNumber(update, "cognition.ai/cachedWriteTokens"),
        totalTokens: 0,
      },
      true,
    );
    sum = sum ? addTokens(sum, tokens) : tokens;
  }
  return sum;
}

/** Whether a response carries Devin's `cognition.ai/*` `_meta` — how its
 *  counting is recognized under a custom harness id. */
function hasDevinMeta(response: PromptResponse): boolean {
  const meta = response._meta;
  return !!meta && Object.keys(meta).some((key) => key.startsWith("cognition.ai/"));
}

/** How Devin counts; `cacheInInput` holds for Devin itself, while a custom
 *  harness recognizes it by its `_meta` (`devinUsageByMeta`). */
const devinUsage: UsageReader = {
  cacheInInput: () => true,
  costTotal: devinCostTotal,
  requestTokens: devinRequestTokens,
  modelRows: () => null,
  updateModel: () => null,
};

export const devinUsageByMeta: UsageReader = {
  ...devinUsage,
  cacheInInput: hasDevinMeta,
};

/** Devin streams a subagent's chunks and usage only to a client that says
 *  it supports subagents; without it a turn that delegates under-reports
 *  (acp-usage-multistep-spike.md). */
export const DEVIN_CLIENT_META = { "cognition.ai/subagentSupport": true };

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
  clientMeta: DEVIN_CLIENT_META,
  usage: devinUsage,
  // A subagent's chunks and usage arrive in the parent session, tagged.
  agentOf: devinAgentOf,
  // The viewBox is tightened around the path's own bounds (70..356 x
  // 49..377) so it sits at the same optical size as the other logos.
  logo: {
    viewBox: "60 39 306 348",
    fillRule: "evenodd",
    paths: [
      { d: "M70 159.333V91.3471C70 88.3592 71.594 85.5983 74.1816 84.1044L133.043 50.1205C135.631 48.6265 138.819 48.6265 141.407 50.1205L200.269 84.1044C202.856 85.5983 204.45 88.3592 204.45 91.3471V126.068C204.708 137.606 210.806 148.734 221.531 154.926C232.256 161.117 244.942 160.834 255.063 155.289L285.132 137.929C287.719 136.435 290.907 136.435 293.495 137.929L352.357 171.913C354.944 173.406 356.538 176.167 356.538 179.155V247.123C356.538 250.111 354.944 252.872 352.357 254.366L293.495 288.35C290.907 289.844 287.719 289.844 285.132 288.35L255.306 271.13C245.146 265.456 232.344 265.117 221.534 271.358C210.809 277.55 204.711 288.678 204.453 300.215V334.926C204.453 337.914 202.859 340.675 200.271 342.169L141.41 376.153C138.822 377.647 135.634 377.647 133.046 376.153L74.1845 342.169C71.5969 340.675 70.0028 337.914 70.0028 334.926V266.959C70.0029 263.971 71.5969 261.21 74.1845 259.716L133.046 225.732C135.634 224.238 138.822 224.238 141.41 225.732L171.547 243.132C181.656 248.638 194.306 248.906 205.005 242.729C215.815 236.488 221.922 225.231 222.088 213.595C221.83 202.057 215.732 189.737 205.008 183.545C194.283 177.353 181.597 177.636 171.476 183.181L141.269 200.72C138.67 202.229 135.461 202.228 132.864 200.716L74.1576 166.562C71.5835 165.065 70 162.311 70 159.333Z" },
    ],
  },
};
