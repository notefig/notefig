import type { HarnessDefinition, SessionNotification } from "@metrists/shared/agent";
import { platformAdapter } from "@/adapters";
import { normalizePath } from "@/utils/fs";
import { AgentWriteGate } from "./agent-write-gate";
import { PermissionBroker } from "./permission-broker";
import type { AgentTransport } from "./agent-transport.interface";

/**
 * One AgentService per workspace (registry convention: git-service-store.ts).
 *
 * Owns: harness selection (from settings — never from document content, and
 * gated by a per-workspace trust confirmation before the first spawn),
 * session lifecycle (initialize → authenticate? → session/new|load → prompt
 * loop), cancellation, and the answered-blob → continuation-prompt pickup.
 */
export class AgentService {
  readonly permissionBroker = new PermissionBroker();
  readonly writeGate = new AgentWriteGate(platformAdapter);

  constructor(
    readonly workspacePath: string,
    readonly harness: HarnessDefinition,
  ) {}

  /** Spawn transport + connect ACP + create or load the session. */
  async start(_transport: AgentTransport): Promise<void> {
    // TODO(phase 1): MetristsAcpClient.connect(), session/new with
    // cwd = workspacePath, persist sessionId in KV ("agent" namespace),
    // try session/load on reopen when the agent advertises loadSession.
    throw new Error("not implemented: AgentService.start");
  }

  /** Send a user prompt; streams session/update into the agent collections. */
  async prompt(_text: string): Promise<void> {
    // TODO(phase 1). Also where answered blobs are injected as a structured
    // preamble ContentBlock before the user text (see architecture doc).
    throw new Error("not implemented: AgentService.prompt");
  }

  /** session/cancel + resolve all pending permissions as cancelled. */
  async cancel(): Promise<void> {
    this.permissionBroker.cancelAll();
    // TODO(phase 1): send session/cancel notification.
  }

  /** Called by blob widgets when the user answers a blob in this workspace. */
  notifyBlobAnswered(_blobRef: { filePath: string; blobId: string }): void {
    // TODO(phase 2): queue; when the session is idle, auto-compose a
    // continuation prompt containing the queued answers.
  }

  handleSessionUpdate(_notification: SessionNotification): void {
    // TODO(phase 1): fan out into agentTurns/agentEvents collections,
    // coalescing message chunks via markdown-joiner-transform.
  }

  async dispose(): Promise<void> {
    await this.cancel();
    // TODO(phase 1): close transport.
  }
}

const agentServiceRegistry = new Map<string, AgentService>();

export function getWorkspaceAgentService(
  workspacePath: string,
): AgentService | undefined {
  return agentServiceRegistry.get(normalizePath(workspacePath));
}

export function createWorkspaceAgentService(
  workspacePath: string,
  harness: HarnessDefinition,
): AgentService {
  const normalized = normalizePath(workspacePath);
  const existing = agentServiceRegistry.get(normalized);
  if (existing) return existing;
  const service = new AgentService(normalized, harness);
  agentServiceRegistry.set(normalized, service);
  return service;
}

export async function disposeWorkspaceAgentService(
  workspacePath: string,
): Promise<void> {
  const normalized = normalizePath(workspacePath);
  const service = agentServiceRegistry.get(normalized);
  agentServiceRegistry.delete(normalized);
  await service?.dispose();
}
