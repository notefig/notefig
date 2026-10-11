/**
 * The throwaway session a harness's catalog probe opens
 * (`CatalogProbeIo.probeSession`): spawn the harness, `initialize`, open a
 * session, keep what it reports for a moment — its settings, and the
 * commands Claude sends right after `session/new` — then delete or close
 * it and stop the process. Nothing is prompted, no MCP server is offered,
 * and it never runs in a workspace: the harness would load that project's
 * hooks and servers before the user asked for anything.
 *
 * Like agent-service, it speaks ACP only through `NotefigAcpClient`.
 */
import { NotefigAcpClient, type AgentTransport } from "@notefig/agent";
import {
  newTaskId,
  type AvailableCommand,
  type HarnessDefinition,
  type SessionConfigSelect,
} from "@notefig/shared/agent";
import type {
  DiscoveredCatalog,
  HarnessAdapter,
} from "@/modules/harness-adapters";

/** How long the session is given to report after it opens: Claude sends
 *  its commands, Devin its settings, within this (spike: ~0.4–2s). */
const SETTLE_MS = 2_000;
/** The whole probe, spawn to close: a harness that hangs is "not found". */
const PROBE_TIMEOUT_MS = 20_000;

export async function probeHarnessSession({
  harness,
  adapter,
  createTransport,
  cwd,
  settleMs = SETTLE_MS,
  timeoutMs = PROBE_TIMEOUT_MS,
}: {
  harness: HarnessDefinition;
  /** What it advertises to the harness at `initialize`. */
  adapter: Pick<HarnessAdapter, "clientMeta">;
  /** The platform's (`proc.createAgentTransport`). */
  createTransport: (spec: {
    taskId: string;
    harness: HarnessDefinition;
    workspacePath: string;
  }) => AgentTransport;
  /** A directory that is no workspace. */
  cwd: string;
  settleMs?: number;
  timeoutMs?: number;
}): Promise<DiscoveredCatalog | null> {
  const taskId = newTaskId();
  let transport: AgentTransport | null = null;
  let configOptions: SessionConfigSelect[] | null = null;
  let commands: AvailableCommand[] | null = null;

  const probe = async (): Promise<DiscoveredCatalog> => {
    transport = createTransport({ taskId, harness, workspacePath: cwd });
    await transport.start();
    const client = new NotefigAcpClient({
      taskId,
      transport,
      // Never prompted, so nothing should ask; anything that does is
      // refused.
      permissionBroker: {
        request: async () => ({ outcome: { outcome: "cancelled" } }),
      },
      onSessionUpdate: ({ update }) => {
        if (update.sessionUpdate === "available_commands_update") {
          commands = update.availableCommands;
        }
      },
      onSessionConfigChange: (_sessionId, options) => {
        configOptions = options;
      },
      fs: {
        readTextFile: () => Promise.reject(new Error("no files in a probe")),
        writeTextFile: () => Promise.reject(new Error("no files in a probe")),
      },
      clientMeta: adapter.clientMeta,
    });
    const initialized = await client.connect();
    const { sessionId } = await client.newSession(transport.agentCwd ?? cwd);
    await new Promise((resolve) => setTimeout(resolve, settleMs));
    // Leave nothing in the harness's history where it lets us; a close
    // (or neither) otherwise — the process stops either way.
    await discard(client, sessionId);
    return {
      configOptions,
      commands,
      ...(initialized.agentInfo?.version
        ? { harnessVersion: initialized.agentInfo.version }
        : {}),
    };
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      probe(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } catch (error) {
    console.warn(`Probing ${harness.id} for its catalog failed:`, error);
    return null;
  } finally {
    clearTimeout(timer);
    await (transport as AgentTransport | null)?.close().catch(() => {});
  }
}

async function discard(client: NotefigAcpClient, sessionId: string) {
  try {
    if (await client.deleteSession(sessionId)) return;
    await client.closeSession(sessionId);
  } catch {
    // Unsupported, or the harness is already going: the process stops next.
  }
}
