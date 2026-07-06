import type {
  ClientCapabilities,
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

/**
 * Capabilities are a function of where the agent process runs relative to
 * the files. Desktop: the app and the files share a machine, so we mediate
 * reads/writes (editor sync, write-gate arbitration). Remote (web): the
 * files live with the harness, not the browser — advertise fs:false and the
 * harness uses its native file tools; the app adopts changes via the watch
 * channel. This asymmetry is the whole reason the CLI worker can stay a
 * protocol-ignorant byte pump.
 */
export function capabilitiesForLocus(
  locus: AgentTransport["locus"],
): ClientCapabilities {
  return locus === "local"
    ? { fs: { readTextFile: true, writeTextFile: true } }
    : { fs: { readTextFile: false, writeTextFile: false } };
}

export type AcpClientDeps = {
  /** The task this connection belongs to — one connection per task. */
  taskId: string;
  transport: AgentTransport;
  permissionBroker: PermissionBroker;
  writeGate: AgentWriteGate;
  /** AgentTask sink for session/update notifications */
  onSessionUpdate: (notification: SessionNotification) => void;
};

/**
 * The Metrists side of one task's ACP connection: implements the
 * client-side methods the protocol requires of us and hands everything
 * else to the owning AgentTask. Wraps the official library's
 * ClientSideConnection over transportToStreams(transport), so it is
 * transport-agnostic by construction. The app is the sole ACP client on
 * both platforms; Rust/CLI-worker layers never parse the protocol.
 */
export class MetristsAcpClient {
  constructor(private readonly deps: AcpClientDeps) {}

  /** Open the connection: initialize + capability negotiation. */
  async connect(): Promise<void> {
    // TODO(phase 1): new ClientSideConnection(this asClient, ...streams)
    // from @zed-industries/agent-client-protocol, then initialize() with
    // capabilitiesForLocus(this.deps.transport.locus).
    throw new Error("not implemented: MetristsAcpClient.connect");
  }

  // ===== ACP client-side methods (called by the agent) =====
  // fs/* are only reachable on desktop (remote advertises fs:false; a
  // misbehaving agent calling them anyway gets a JSON-RPC error).

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
    await this.deps.writeGate.writeTextFile(
      this.deps.taskId,
      request.path,
      request.content,
    );
  }

  async sessionUpdate(notification: SessionNotification): Promise<void> {
    this.deps.onSessionUpdate(notification);
  }
}
