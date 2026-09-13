/**
 * The Node implementation of the `proc` surface's agent transport: spawn a
 * harness as a local child process and expose its stdio as the line channel
 * `AgentTransport` promises. Desktop's equivalent lives in Rust
 * (src-tauri/src/agent_proc.rs, driven by tauri-stdio-transport.ts); this is
 * the same contract satisfied from a headless Node host, which is what lets
 * the ACP session layer run with no app.
 *
 * Two deliberate differences from the desktop path:
 *
 *  - **No login-shell PATH probe.** `agent_proc.rs` re-derives PATH via
 *    `$SHELL -ilc` because a macOS GUI app inherits launchd's minimal
 *    environment and can't find npx. A CLI already runs inside the user's
 *    shell with the user's PATH — the probe would be re-deriving what we
 *    were handed.
 *  - **No byte pumping.** ../agent-worker.ts forwards the same stdio to a
 *    paired browser without parsing it; here the ACP client sits directly on
 *    the other end of this transport, in-process.
 */
import { spawn, type ChildProcess } from 'child_process';
import {
  AgentTransportError,
  type AgentTransport,
  type SpawnAgentInfo,
  type Unsubscribe,
} from '../agent';
import { resolveHarnessSpawn, type HarnessDefinition } from '../shared';
import { LineBuffer } from './line-buffer';
import { TransportListeners } from './transport-listeners';

/** How long a harness gets to exit on SIGTERM before the group is SIGKILLed. */
const KILL_GRACE_MS = 5_000;

export type NodeAgentTransportSpec = {
  harness: HarnessDefinition;
  /** Absolute path to the workspace; the harness spawns here. */
  workspacePath: string;
  /** Per-task env layered over the harness's static env. */
  extraEnv?: Record<string, string>;
};

/**
 * Kill a harness's whole process tree, not just the process we spawned.
 *
 * The built-in harnesses are npx wrappers, so the direct child is a launcher
 * and the real adapter is a grandchild. Killing only the wrapper leaves the
 * adapter reparented to init and running — verified on the desktop side
 * (agent_proc.rs:112-118), where an orphaned adapter survived stdin EOF for
 * minutes. Unix: `detached: true` at spawn makes the child a process-group
 * leader whose pgid is its pid, so a negative-pid signal reaches the group.
 * Windows has no process groups in this sense; `taskkill /T` walks the tree
 * instead (the Rust host uses a Job Object, which Node cannot create).
 */
function killProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    // /T kills the tree, /F forces it. SIGTERM has no Windows analogue, so
    // the graceful attempt is skipped there and the tree is taken down once.
    if (signal === 'SIGKILL') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore',
      }).on('error', () => {
        /* best effort: the child may already be gone */
      });
    }
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    // ESRCH: the group is already gone. Nothing to do.
  }
}

export class NodeAgentTransport implements AgentTransport {
  readonly locus = 'local' as const;

  private child: ChildProcess | null = null;
  private info: SpawnAgentInfo | undefined;
  private closed = false;
  private readonly listeners = new TransportListeners();

  constructor(private readonly spec: NodeAgentTransportSpec) {}

  get spawnInfo(): SpawnAgentInfo | undefined {
    return this.info;
  }

  async start(): Promise<void> {
    if (this.child) return; // idempotent-safe, per the interface contract

    const { harness, workspacePath, extraEnv } = this.spec;
    // Templating and the cwd default belong to the harness definition, not to
    // any one host — same call the worker and the desktop adapter make.
    const { args, cwd } = resolveHarnessSpawn(harness, workspacePath);

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...harness.env,
      ...extraEnv,
    };
    // Adapters misbehave if they think they're running inside Claude Code —
    // the same strip the desktop host and the worker apply.
    delete env.CLAUDECODE;

    let child: ChildProcess;
    try {
      child = spawn(harness.command, args, {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        // Own process group, so teardown reaches the whole tree.
        detached: process.platform !== 'win32',
      });
    } catch (error: any) {
      throw new AgentTransportError(
        'spawn_failed',
        `could not start ${harness.command}: ${error?.message ?? error}`,
      );
    }

    this.child = child;
    this.info = {
      pid: child.pid,
      program: harness.command,
      args,
      cwd,
    };

    const stdout = new LineBuffer((lines) => this.listeners.emitLines(lines));
    const stderr = new LineBuffer((lines) =>
      this.listeners.emitDiagnostics(lines),
    );
    child.stdout?.on('data', (chunk) => stdout.push(chunk));
    child.stderr?.on('data', (chunk) => stderr.push(chunk));

    // `spawn` throwing synchronously only covers argument errors; a missing
    // binary surfaces asynchronously as an 'error' event, so both paths must
    // produce the same spawn_failed rejection.
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', (error) =>
        reject(
          new AgentTransportError(
            'spawn_failed',
            `could not start ${harness.command}: ${error.message}`,
          ),
        ),
      );
    });

    child.once('exit', (code, signal) => {
      stdout.flush();
      stderr.flush();
      // An exit we didn't ask for is a transport death; one that follows
      // close() is just teardown completing.
      this.listeners.emitClose(
        this.closed
          ? undefined
          : new AgentTransportError(
              'closed',
              `${harness.command} exited (${signal ?? `code ${code}`})`,
            ),
      );
    });
  }

  send(line: string): void {
    // A write after the child is gone is a normal race at turn end, not an
    // error worth throwing into the ACP stream.
    if (!this.child?.stdin?.writable) return;
    this.child.stdin.write(line + '\n');
  }

  onLine(callback: (line: string) => void): Unsubscribe {
    return this.listeners.onLine(callback);
  }

  onClose(callback: (error?: AgentTransportError) => void): Unsubscribe {
    return this.listeners.onClose(callback);
  }

  onDiagnostic(callback: (line: string) => void): Unsubscribe {
    return this.listeners.onDiagnostic(callback);
  }

  async close(): Promise<void> {
    const child = this.child;
    if (!child || this.closed) return;
    this.closed = true;
    if (child.exitCode !== null || child.signalCode !== null) return;

    await new Promise<void>((resolve) => {
      const forceKill = setTimeout(() => {
        killProcessTree(child, 'SIGKILL');
      }, KILL_GRACE_MS);
      // Unref so a lingering grace timer can't hold the CLI's event loop open.
      forceKill.unref?.();
      child.once('exit', () => {
        clearTimeout(forceKill);
        resolve();
      });
      killProcessTree(child, 'SIGTERM');
      if (process.platform === 'win32') {
        // No SIGTERM equivalent — go straight to the forced tree kill.
        killProcessTree(child, 'SIGKILL');
      }
    });
  }

}

/**
 * The `proc` surface's `createAgentTransport`, Node edition: a dumb
 * constructor that does nothing async — the caller calls `start()` and reads
 * `spawnInfo` afterward, exactly as the desktop adapter's contract specifies.
 */
export function createNodeAgentTransport(
  spec: NodeAgentTransportSpec,
): AgentTransport {
  return new NodeAgentTransport(spec);
}
