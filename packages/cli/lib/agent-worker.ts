/**
 * The `metrists agent` worker — one file, one job: pump bytes between a
 * paired browser and locally-spawned agent processes. It speaks the tunnel
 * protocol (packages/shared/src/tunnel) but never parses an ACP or MCP line.
 *
 * Two byte channels, both keyed by id, neither inspected:
 *   - "acp":  a harness child's stdio  ↔ frames tagged by taskId
 *   - "mcp":  a harness-spawned MCP relay's loopback socket ↔ frames tagged
 *             by taskId + connId (the MCP inversion; the request handler lives
 *             in the browser — this side is a socket pump)
 * Plus "ctl" for the pairing handshake and task/MCP lifecycle.
 *
 * Transport: a plain WebSocket server on 127.0.0.1. The browser connects
 * directly (loopback is exempt from mixed-content, so an https page may open
 * ws://127.0.0.1). The pairing-derived key still authenticates every
 * connection and encrypts every frame, so a stray local process can't drive
 * the worker, and `--tunnel-url` (bring-your-own tunnel) stays end-to-end
 * safe against an untrusted relay. There is no bundled tunnel binary.
 *
 * Security boundary: the worker only ever spawns / probes harnesses it knows
 * from @metrists/shared's hardcoded BUILT_IN_HARNESSES — nothing executable
 * ever crosses the wire. start-task carries only a harnessId + cwd + env.
 */
import * as http from 'http';
import * as net from 'net';
import { randomBytes } from 'crypto';
import { spawn, exec, type ChildProcess } from 'child_process';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  BUILT_IN_HARNESSES,
  CtlMessageSchema,
  FrameCipher,
  MCP_SERVER_NAME,
  TUNNEL_PROTOCOL_VERSION,
  TunnelEnvelopeSchema,
  deriveFrameKey,
  deriveSessionKey,
  type CtlMessage,
  type HarnessAdvert,
  type HarnessDefinition,
  type InnerFrame,
  type McpServerSpec,
  type TunnelErrorCode,
} from '@metrists/shared';
import type { Logger } from './utils/logger.util';

const KILL_GRACE_MS = 5_000;

// ========================================================================
// Newline framing for child stdio and loopback sockets
// ========================================================================

class LineBuffer {
  private tail = '';
  constructor(private readonly onLine: (line: string) => void) {}
  push(chunk: Buffer | string): void {
    const pieces = (this.tail + chunk.toString()).split('\n');
    this.tail = pieces.pop() ?? '';
    for (const line of pieces) if (line.length > 0) this.onLine(line);
  }
  flush(): void {
    if (this.tail.length > 0) {
      const line = this.tail;
      this.tail = '';
      this.onLine(line);
    }
  }
}

// ========================================================================
// Harness discovery — only ever runs shared-hardcoded probe commands
// ========================================================================

function runProbe(probe: string): Promise<boolean> {
  return new Promise((resolve) => {
    exec(probe, { timeout: 10_000 }, (error, stdout) =>
      resolve(!error && stdout.trim().length > 0),
    );
  });
}

/**
 * Probe which built-in harnesses this machine has, for the pair-ack advert.
 * Only the probe strings that ship in BUILT_IN_HARNESSES are ever exec'd —
 * never a command from the wire. A user-configured (non-built-in) harness is
 * assumed available rather than probed, which is what keeps arbitrary-command
 * execution off the table entirely.
 */
export async function probeHarnesses(): Promise<HarnessAdvert[]> {
  return Promise.all(
    BUILT_IN_HARNESSES.map(async (harness) => ({
      id: harness.id,
      available: await runProbe(
        harness.probeCommand ?? `command -v ${harness.command}`,
      ),
    })),
  );
}

// ========================================================================
// Path translation (browser workspace root → worker --dir)
// ========================================================================

/**
 * The browser names files by its own workspace-root prefix (its fs adapter's
 * path); the worker spawns the agent in its real --dir. When those name the
 * same physical folder (the same-machine model), swap the leading browser
 * root in a path — the agent's cwd, or a path-bearing env like
 * OPENCODE_CONFIG — for the worker's root. Non-matching values pass through.
 */
export function rewriteToWorkspaceRoot(
  value: string,
  browserRoot: string,
  workerRoot: string,
): string {
  if (value === browserRoot) return workerRoot;
  const prefix = browserRoot.endsWith('/') ? browserRoot : `${browserRoot}/`;
  if (value.startsWith(prefix)) {
    return `${workerRoot.replace(/\/$/, '')}/${value.slice(prefix.length)}`;
  }
  return value;
}

// ========================================================================
// MCP inversion — one loopback listener per task
// ========================================================================

export type McpRelayCommandBuilder = (port: number) => {
  command: string;
  args: string[];
};

/** The relay the harness spawns is this CLI itself (hidden `mcp-relay`). */
export const defaultRelayCommand: McpRelayCommandBuilder = (port) => ({
  command: process.execPath,
  args: [process.argv[1], 'mcp-relay', '--port', String(port)],
});

type McpListener = {
  server: net.Server;
  token: string;
  connections: Map<number, net.Socket>;
};

// ========================================================================
// The worker
// ========================================================================

export type AgentWorkerOptions = {
  secret: Uint8Array;
  /** Resolved --dir; the real cwd every agent spawns in. */
  workspacePath: string;
  workerName: string;
  harnesses: HarnessAdvert[];
  logger: Logger;
  /** 0 (default) = ephemeral; the actual port comes back from start(). */
  port?: number;
  /** Test seams. */
  harnessDefinitions?: HarnessDefinition[];
  buildRelayCommand?: McpRelayCommandBuilder;
};

type Peer = {
  socket: WebSocket;
  cipher: FrameCipher;
  challenge: string;
  paired: boolean;
};

export class AgentWorker {
  private httpServer: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private peer: Peer | null = null;
  private frameKey: Uint8Array | null = null;

  private readonly harnesses: HarnessDefinition[];
  private readonly buildRelayCommand: McpRelayCommandBuilder;

  /** Live agent processes, keyed by taskId. */
  private readonly tasks = new Map<string, ChildProcess>();
  /** Live MCP loopback listeners, keyed by taskId. */
  private readonly mcp = new Map<string, McpListener>();
  private nextConnId = 1;

  constructor(private readonly options: AgentWorkerOptions) {
    this.harnesses = options.harnessDefinitions ?? BUILT_IN_HARNESSES;
    this.buildRelayCommand = options.buildRelayCommand ?? defaultRelayCommand;
  }

  // ---- lifecycle ----

  async start(): Promise<number> {
    this.frameKey = await deriveFrameKey(this.options.secret);
    this.httpServer = http.createServer();
    this.wss = new WebSocketServer({ server: this.httpServer });
    this.wss.on('connection', (socket) => void this.onConnection(socket));
    return new Promise<number>((resolve, reject) => {
      this.httpServer!.once('error', reject);
      this.httpServer!.listen(this.options.port ?? 0, '127.0.0.1', () =>
        resolve((this.httpServer!.address() as net.AddressInfo).port),
      );
    });
  }

  async stop(): Promise<void> {
    this.peer?.socket.close();
    this.peer = null;
    await this.teardownPeer();
    this.wss?.close();
    await new Promise<void>((resolve) =>
      this.httpServer ? this.httpServer.close(() => resolve()) : resolve(),
    );
  }

  /** Socket loss = workspace close: every child + listener goes down. */
  private async teardownPeer(): Promise<void> {
    await Promise.all([...this.tasks.keys()].map((id) => this.stopTask(id)));
    for (const taskId of [...this.mcp.keys()]) this.closeMcp(taskId);
  }

  // ---- connection + handshake ----

  private async onConnection(socket: WebSocket): Promise<void> {
    if (this.peer) {
      this.sendPlaintextError(socket, 'busy', 'another browser is paired');
      socket.close();
      return;
    }
    const challengeBytes = randomBytes(16);
    const challenge = challengeBytes.toString('base64');
    const sessionKey = await deriveSessionKey(
      this.frameKey!,
      new Uint8Array(challengeBytes),
    );
    const peer: Peer = {
      socket,
      cipher: new FrameCipher(sessionKey, 'worker'),
      challenge,
      paired: false,
    };
    this.peer = peer;

    socket.on('message', (raw) => void this.onMessage(peer, raw.toString()));
    socket.on('error', () => socket.close());
    socket.on('close', () => {
      if (this.peer !== peer) return;
      this.peer = null;
      this.options.logger.info('Browser disconnected — stopping tasks.');
      void this.teardownPeer();
    });

    socket.send(
      JSON.stringify({ v: TUNNEL_PROTOCOL_VERSION, t: 'hello', challenge }),
    );
  }

  private async onMessage(peer: Peer, raw: string): Promise<void> {
    let envelope;
    try {
      envelope = TunnelEnvelopeSchema.parse(JSON.parse(raw));
    } catch {
      return this.failPeer(peer, 'protocol-error', 'malformed envelope');
    }
    if (envelope.t === 'error') {
      this.options.logger.warn(`Peer error: ${envelope.code} ${envelope.message}`);
      return void peer.socket.close();
    }
    if (envelope.t !== 'frame') {
      return this.failPeer(peer, 'protocol-error', 'unexpected envelope type');
    }
    const inner = peer.cipher.open(envelope);
    if (!inner) {
      return this.failPeer(
        peer,
        peer.paired ? 'protocol-error' : 'pairing-failed',
        peer.paired ? 'bad frame' : 'pairing failed',
      );
    }
    if (!peer.paired) return this.tryPair(peer, inner);
    await this.route(inner);
  }

  private tryPair(peer: Peer, inner: InnerFrame): void {
    const pair =
      inner.ch === 'ctl' ? CtlMessageSchema.safeParse(inner.data) : null;
    if (
      !pair?.success ||
      pair.data.op !== 'pair' ||
      pair.data.challenge !== peer.challenge
    ) {
      return this.failPeer(peer, 'pairing-failed', 'pairing failed');
    }
    peer.paired = true;
    this.options.logger.info('Browser paired.');
    this.sendCtl({
      op: 'pair-ack',
      worker: {
        name: this.options.workerName,
        workspacePath: this.options.workspacePath,
        harnesses: this.options.harnesses,
        protocol: TUNNEL_PROTOCOL_VERSION,
      },
    });
  }

  // ---- frame routing ----

  private async route(inner: InnerFrame): Promise<void> {
    switch (inner.ch) {
      case 'acp':
        // Unknown taskId is routine (a late frame after exit) — drop it.
        if (inner.taskId && typeof inner.data === 'string') {
          this.tasks.get(inner.taskId)?.stdin?.write(`${inner.data}\n`);
        }
        return;
      case 'mcp':
        if (
          inner.taskId &&
          typeof inner.connId === 'number' &&
          typeof inner.data === 'string'
        ) {
          this.mcp
            .get(inner.taskId)
            ?.connections.get(inner.connId)
            ?.write(`${inner.data}\n`);
        }
        return;
      case 'ctl': {
        const parsed = CtlMessageSchema.safeParse(inner.data);
        if (parsed.success) await this.handleCtl(parsed.data);
        return;
      }
    }
  }

  private async handleCtl(message: CtlMessage): Promise<void> {
    switch (message.op) {
      case 'start-task':
        return this.startTaskFromCtl(message);
      case 'stop-task':
        return this.stopTask(message.taskId);
      case 'mcp-open': {
        const mcpServer = await this.openMcp(message.taskId);
        this.sendCtl({ op: 'mcp-opened', taskId: message.taskId, mcpServer });
        return;
      }
      case 'mcp-close':
        return this.closeMcp(message.taskId);
      default:
        return; // pair handled pre-routing; worker→browser ops never arrive
    }
  }

  // ---- task supervision ----

  private startTaskFromCtl(
    message: Extract<CtlMessage, { op: 'start-task' }>,
  ): void {
    const { taskId } = message;
    if (this.tasks.has(taskId)) return;

    const harness = this.harnesses.find((h) => h.id === message.harnessId);
    if (!harness) {
      this.sendCtl({
        op: 'task-spawn-error',
        taskId,
        message: `unknown harness: ${message.harnessId}`,
      });
      return;
    }

    // The agent spawns in the worker's real --dir; the browser's workspace
    // prefix in cwd + any path-bearing env is rewritten to that root.
    const cwd = this.options.workspacePath;
    const env: NodeJS.ProcessEnv = { ...process.env, ...harness.env };
    for (const [key, value] of Object.entries(message.extraEnv)) {
      env[key] = rewriteToWorkspaceRoot(value, message.cwd, cwd);
    }
    // Adapters misbehave if they think they're inside Claude Code (same strip
    // the desktop host applies).
    delete env.CLAUDECODE;
    const args = harness.args.map((arg) => arg.split('${workspace}').join(cwd));

    let child: ChildProcess;
    try {
      child = spawn(harness.command, args, {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error: any) {
      this.sendCtl({ op: 'task-spawn-error', taskId, message: String(error?.message ?? error) });
      return;
    }
    this.tasks.set(taskId, child);

    const stdout = new LineBuffer((line) => this.send({ ch: 'acp', taskId, data: line }));
    const stderr = new LineBuffer((line) =>
      this.sendCtl({ op: 'task-diagnostic', taskId, line }),
    );
    child.stdout!.on('data', (chunk) => stdout.push(chunk));
    child.stderr!.on('data', (chunk) => stderr.push(chunk));

    child.once('spawn', () => this.sendCtl({ op: 'task-started', taskId }));
    child.once('error', (error) => {
      if (this.tasks.delete(taskId)) {
        this.sendCtl({ op: 'task-spawn-error', taskId, message: error.message });
      }
    });
    child.once('exit', (code) => {
      stdout.flush();
      stderr.flush();
      if (this.tasks.delete(taskId)) {
        this.closeMcp(taskId);
        this.sendCtl({ op: 'task-exit', taskId, code });
      }
    });
  }

  private async stopTask(taskId: string): Promise<void> {
    const child = this.tasks.get(taskId);
    if (!child) return;
    await new Promise<void>((resolve) => {
      const kill = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
      child.once('exit', () => {
        clearTimeout(kill);
        resolve();
      });
      child.kill('SIGTERM');
    });
  }

  // ---- MCP loopback listeners ----

  private async openMcp(taskId: string): Promise<McpServerSpec> {
    this.closeMcp(taskId);
    const token = randomBytes(24).toString('base64url');
    const listener: McpListener = {
      server: net.createServer(),
      token,
      connections: new Map(),
    };
    this.mcp.set(taskId, listener);

    listener.server.on('connection', (socket) => {
      let connId: number | null = null;
      const lines = new LineBuffer((line) => {
        if (connId === null) {
          // First line must be the token, else it isn't our relay.
          if (line !== listener.token) return void socket.destroy();
          connId = this.nextConnId++;
          listener.connections.set(connId, socket);
          return;
        }
        this.send({ ch: 'mcp', taskId, connId, data: line });
      });
      socket.on('data', (chunk) => lines.push(chunk));
      socket.on('error', () => socket.destroy());
      socket.on('close', () => {
        if (connId !== null) listener.connections.delete(connId);
      });
    });

    const port = await new Promise<number>((resolve, reject) => {
      listener.server.once('error', reject);
      listener.server.listen(0, '127.0.0.1', () =>
        resolve((listener.server.address() as net.AddressInfo).port),
      );
    });

    const relay = this.buildRelayCommand(port);
    return {
      name: MCP_SERVER_NAME,
      command: relay.command,
      args: relay.args,
      env: [{ name: 'METRISTS_MCP_TOKEN', value: token }],
    };
  }

  private closeMcp(taskId: string): void {
    const listener = this.mcp.get(taskId);
    if (!listener) return;
    this.mcp.delete(taskId);
    for (const socket of listener.connections.values()) socket.destroy();
    listener.server.close();
  }

  // ---- outbound framing ----

  private send(inner: InnerFrame): void {
    const peer = this.peer;
    if (!peer?.paired) return;
    peer.socket.send(JSON.stringify(peer.cipher.seal(inner)));
  }

  private sendCtl(message: CtlMessage): void {
    this.send({ ch: 'ctl', data: message });
  }

  private sendPlaintextError(
    socket: WebSocket,
    code: TunnelErrorCode,
    message: string,
  ): void {
    socket.send(
      JSON.stringify({ v: TUNNEL_PROTOCOL_VERSION, t: 'error', code, message }),
    );
  }

  private failPeer(peer: Peer, code: TunnelErrorCode, message: string): void {
    this.sendPlaintextError(peer.socket, code, message);
    peer.socket.close();
  }
}
