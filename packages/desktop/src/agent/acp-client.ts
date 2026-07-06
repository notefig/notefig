import type {
  ReadTextFileRequest,
  ReadTextFileResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  WriteTextFileRequest,
} from "@metrists/shared/agent";
import type { AgentTransport } from "./agent-transport.interface";
import type { AgentWriteGate } from "./agent-write-gate";
import type { PermissionBroker } from "./permission-broker";

export type AcpClientDeps = {
  transport: AgentTransport;
  permissionBroker: PermissionBroker;
  writeGate: AgentWriteGate;
  /** AgentService sink for session/update notifications */
  onSessionUpdate: (notification: SessionNotification) => void;
};

/**
 * The Metrists side of the ACP connection: implements the client-side
 * methods the protocol requires of us and hands everything else to
 * AgentService. Wraps the official library's ClientSideConnection over
 * transportToStreams(transport), so it is transport-agnostic by
 * construction.
 *
 * Capabilities advertised at initialize (phase 1):
 *   { fs: { readTextFile: true, writeTextFile: true } } — terminal off.
 */
export class MetristsAcpClient {
  constructor(private readonly deps: AcpClientDeps) {}

  /** Open the connection: initialize + capability negotiation. */
  async connect(): Promise<void> {
    // TODO(phase 1): new ClientSideConnection(this asClient, ...streams)
    // from @zed-industries/agent-client-protocol, then initialize().
    throw new Error("not implemented: MetristsAcpClient.connect");
  }

  // ===== ACP client-side methods (called by the agent) =====

  async requestPermission(
    request: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    return this.deps.permissionBroker.request(request);
  }

  async readTextFile(request: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    const content = await this.deps.writeGate.readTextFile(request.path, {
      line: request.line ?? undefined,
      limit: request.limit ?? undefined,
    });
    return { content };
  }

  async writeTextFile(request: WriteTextFileRequest): Promise<void> {
    await this.deps.writeGate.writeTextFile(request.path, request.content);
  }

  async sessionUpdate(notification: SessionNotification): Promise<void> {
    this.deps.onSessionUpdate(notification);
  }
}
