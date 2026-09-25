// Entry of the bundled Claude ACP adapter sidecar (MET-210).
//
// This is what gets compiled into `claude-agent-acp-<triple>`: the adapter's
// own `bin` entry minus its `--cli`/`--version` shims, plus one job of ours —
// pointing the adapter at the user's installed Claude Code CLI. The adapter
// honours CLAUDE_CODE_EXECUTABLE; without it, it would look for the SDK's
// platform-specific optional dependency (the ~200 MB native CLI), which the
// sidecar deliberately does not ship. The user needs `claude` for auth
// anyway, so it stays the one external dependency.
//
// Keep this file free of top-level await: the single-executable build runs
// it as CommonJS.
import { accessSync, appendFileSync, constants, mkdirSync } from "node:fs";
import { delimiter, join } from "node:path";
import {
  runAcp,
} from "@agentclientprotocol/claude-agent-acp/dist/acp-agent.js";
import { applyManagedPolicyEnv } from "@agentclientprotocol/claude-agent-acp/dist/managed-policy.js";

function isExecutable(file) {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Every `<dir>/<name><ext>` PATH could mean, PATHEXT-aware on Windows so a
 *  native `claude.exe` resolves. */
function pathCandidates(name) {
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")
      : [""];
  const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  return dirs.flatMap((dir) => exts.map((ext) => join(dir, name + ext)));
}

/** `command -v`, portably: the first executable named `name` on PATH. */
function findOnPath(name) {
  return pathCandidates(name).find(isExecutable);
}

async function main() {
  if (!process.env.CLAUDE_CODE_EXECUTABLE) {
    const found = findOnPath("claude");
    if (!found) {
      console.error(
        "claude-agent-acp: Claude Code CLI not found on PATH. Install it " +
          "(https://claude.com/claude-code) or set CLAUDE_CODE_EXECUTABLE.",
      );
      process.exit(1);
    }
    process.env.CLAUDE_CODE_EXECUTABLE = found;
  }

  // Everything below mirrors the adapter's dist/index.js default branch.
  await applyManagedPolicyEnv();
  // stdout carries ACP; everything else goes to stderr.
  console.log = console.error;
  console.info = console.error;
  console.warn = console.error;
  console.debug = console.error;
  process.on("unhandledRejection", (reason, promise) => {
    console.error("Unhandled Rejection at:", promise, "reason:", reason);
  });
  const logDirectory = process.env.CLAUDE_AGENT_LOGS;
  const logger = logDirectory
    ? (() => {
        mkdirSync(logDirectory, { recursive: true });
        const logFile = join(logDirectory, "agent.log");
        const writeLog = (...args) => {
          const rendered = args
            .map((arg) =>
              arg instanceof Error ? (arg.stack ?? arg.message) : String(arg),
            )
            .join(" ");
          appendFileSync(
            logFile,
            `${new Date().toISOString()} pid=${process.pid} ${rendered}\n`,
          );
        };
        return {
          log: writeLog,
          error: (...args) => {
            console.error(...args);
            writeLog(...args);
          },
        };
      })()
    : undefined;
  logger?.log("Claude ACP started (notefig sidecar)");
  const { connection, agent } = runAcp(logger);
  async function shutdown() {
    await agent.dispose().catch((err) => {
      console.error("Error during cleanup:", err);
    });
    process.exit(0);
  }
  connection.closed.then(shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  process.stdin.resume();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
