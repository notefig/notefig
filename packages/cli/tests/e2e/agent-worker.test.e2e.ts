import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import * as os from 'os';
import * as net from 'net';
import * as path from 'path';
import { promises as fs } from 'fs';
import { join } from 'path';
import WebSocket = require('ws');
import {
  FrameCipher,
  TunnelEnvelopeSchema,
  deriveFrameKey,
  deriveSessionKey,
  generatePairingSecret,
  type CtlMessage,
  type InnerFrame,
  type TunnelEnvelope,
} from '@metrists/shared';
import { AgentWorker } from '../../lib/agent-worker';
import type { HarnessDefinition } from '@metrists/shared';
import { Logger, type LogTypes } from '../../lib/utils/logger.util';

const FIXTURE = join(__dirname, 'fixtures', 'scripted-agent.js');

const scriptedHarness: HarnessDefinition = {
  id: 'scripted',
  label: 'Scripted fixture',
  command: process.execPath,
  args: [FIXTURE],
  env: {},
  mcpRegistration: 'none',
};

class SilentLogger extends Logger {
  info() {}
  warn() {}
  error() {}
  verbose() {}
  noob() {}
  log(_types: LogTypes[]) {}
}

/** A protocol-conformant fake browser built only on the shared module. */
class FakeBrowser {
  socket: WebSocket;
  cipher: FrameCipher | null = null;
  frames: InnerFrame[] = [];
  errors: Extract<TunnelEnvelope, { t: 'error' }>[] = [];
  closed = false;

  private constructor(socket: WebSocket) {
    this.socket = socket;
  }

  static async connect(
    port: number,
    secret: Uint8Array,
    options: { wrongKey?: boolean; badChallenge?: boolean } = {},
  ): Promise<FakeBrowser> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    const browser = new FakeBrowser(socket);
    socket.on('close', () => {
      browser.closed = true;
    });

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('no hello/error within 5s')),
        5000,
      );
      socket.on('message', (raw) => {
        void (async () => {
          const envelope = TunnelEnvelopeSchema.parse(
            JSON.parse(raw.toString()),
          );
          if (envelope.t === 'error') {
            browser.errors.push(envelope);
            clearTimeout(timeout);
            resolve();
            return;
          }
          if (envelope.t === 'hello') {
            const frameKey = await deriveFrameKey(
              options.wrongKey ? generatePairingSecret() : secret,
            );
            const sessionKey = await deriveSessionKey(
              frameKey,
              new Uint8Array(Buffer.from(envelope.challenge, 'base64')),
            );
            browser.cipher = new FrameCipher(sessionKey, 'browser');
            browser.send({
              ch: 'ctl',
              data: {
                op: 'pair',
                challenge: options.badChallenge ? 'nope' : envelope.challenge,
              },
            });
            clearTimeout(timeout);
            resolve();
            return;
          }
          const inner = browser.cipher?.open(envelope);
          if (inner) browser.frames.push(inner);
        })();
      });
      socket.on('error', reject);
    });
    return browser;
  }

  send(inner: InnerFrame): void {
    this.socket.send(JSON.stringify(this.cipher!.seal(inner)));
  }

  sendRaw(envelope: unknown): void {
    this.socket.send(JSON.stringify(envelope));
  }

  async waitFor<T>(pick: () => T | undefined, timeoutMs = 5000): Promise<T> {
    const started = Date.now();
    for (;;) {
      const found = pick();
      if (found !== undefined) return found;
      if (Date.now() - started > timeoutMs) {
        throw new Error('waitFor timed out');
      }
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  ctl(op: CtlMessage['op']): CtlMessage | undefined {
    for (const frame of this.frames) {
      if (frame.ch !== 'ctl') continue;
      const message = frame.data as CtlMessage;
      if (message.op === op) return message;
    }
    return undefined;
  }

  close(): void {
    this.socket.close();
  }
}

describe('AgentWorker', () => {
  let workspace: string;
  let secret: Uint8Array;
  let worker: AgentWorker;
  let port: number;

  beforeEach(async () => {
    // Canonicalized like agent.command's resolveWorkspace does for --dir
    // (macOS tmpdir is a /var → /private/var symlink).
    workspace = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'metrists-worker-')),
    );
    secret = generatePairingSecret();
    worker = new AgentWorker({
      secret,
      workspacePath: workspace,
      workerName: 'test-worker',
      harnesses: [{ id: 'scripted', available: true }],
      logger: new SilentLogger(),
      harnessDefinitions: [scriptedHarness],
      // Tests drive the MCP listener with a raw socket, not a spawned relay.
      buildRelayCommand: (mcpPort) => ({
        command: 'noop',
        args: [String(mcpPort)],
      }),
    });
    port = await worker.start();
  });

  afterEach(async () => {
    await worker.stop();
    await fs.rm(workspace, { recursive: true, force: true });
  });

  async function pair(): Promise<FakeBrowser> {
    const browser = await FakeBrowser.connect(port, secret);
    await browser.waitFor(() => browser.ctl('pair-ack'));
    return browser;
  }

  it('handshakes and advertises worker info in pair-ack', async () => {
    const browser = await pair();
    const ack = browser.ctl('pair-ack') as Extract<
      CtlMessage,
      { op: 'pair-ack' }
    >;
    expect(ack.worker.name).toBe('test-worker');
    expect(ack.worker.workspacePath).toBe(workspace);
    expect(ack.worker.harnesses).toEqual([{ id: 'scripted', available: true }]);
    browser.close();
  });

  it('rejects a wrong key with pairing-failed', async () => {
    const browser = await FakeBrowser.connect(port, secret, { wrongKey: true });
    await browser.waitFor(() =>
      browser.errors.find((e) => e.code === 'pairing-failed'),
    );
  });

  it('rejects a wrong challenge echo with pairing-failed', async () => {
    const browser = await FakeBrowser.connect(port, secret, {
      badChallenge: true,
    });
    await browser.waitFor(() =>
      browser.errors.find((e) => e.code === 'pairing-failed'),
    );
  });

  it('answers a second concurrent socket with busy', async () => {
    const first = await pair();
    const second = await FakeBrowser.connect(port, secret);
    await second.waitFor(() => second.errors.find((e) => e.code === 'busy'));
    first.close();
  });

  it('hard-closes on a replayed frame', async () => {
    const browser = await pair();
    const envelope = browser.cipher!.seal({
      ch: 'ctl',
      data: { op: 'stop-task', taskId: 'none' },
    });
    browser.sendRaw(envelope);
    browser.sendRaw(envelope); // same seq again
    await browser.waitFor(() => (browser.closed ? true : undefined));
  });

  it('runs a task end to end: start, acp round-trip, exit', async () => {
    const browser = await pair();
    browser.send({
      ch: 'ctl',
      data: {
        op: 'start-task',
        taskId: 't1',
        harnessId: 'scripted',
        cwd: workspace,
        extraEnv: {},
      },
    });
    await browser.waitFor(() => browser.ctl('task-started'));
    await browser.waitFor(() =>
      browser.frames.find((f) => f.ch === 'acp' && f.data === 'ready'),
    );

    browser.send({ ch: 'acp', taskId: 't1', data: 'ping' });
    await browser.waitFor(() =>
      browser.frames.find((f) => f.ch === 'acp' && f.data === 'echo:ping'),
    );

    browser.send({ ch: 'acp', taskId: 't1', data: 'exit:0' });
    await browser.waitFor(() => browser.ctl('task-exit'));
    browser.close();
  });

  it('reports unknown-harness starts as task-spawn-error', async () => {
    const browser = await pair();
    browser.send({
      ch: 'ctl',
      data: {
        op: 'start-task',
        taskId: 't1',
        harnessId: 'nope',
        cwd: workspace,
        extraEnv: {},
      },
    });
    const error = await browser.waitFor(() => browser.ctl('task-spawn-error'));
    expect((error as any).message).toContain('unknown harness');
    browser.close();
  });

  it('spawns in --dir and rewrites the browser workspace prefix in env', async () => {
    const browser = await pair();
    // The scripted fixture writes its own cwd (via process.cwd()) — but we
    // assert the env rewrite through a wrapper that echoes OPENCODE_CONFIG.
    browser.send({
      ch: 'ctl',
      data: {
        op: 'start-task',
        taskId: 't1',
        harnessId: 'scripted',
        // Browser addresses files under its own synthetic root:
        cwd: '/browser-root',
        extraEnv: {
          OPENCODE_CONFIG: '/browser-root/.metrists/agent/opencode-t1.json',
          UNCHANGED: '/somewhere/else',
        },
      },
    });
    await browser.waitFor(() => browser.ctl('task-started'));

    // Observe the spawned process's real cwd and env through the fixture.
    browser.send({ ch: 'acp', taskId: 't1', data: 'cwd' });
    const cwdLine = await browser.waitFor(() =>
      browser.frames.find(
        (f) => f.ch === 'acp' && String(f.data).startsWith('cwd:'),
      ),
    );
    expect(String(cwdLine.data)).toBe(`cwd:${workspace}`);

    browser.send({ ch: 'acp', taskId: 't1', data: 'env:OPENCODE_CONFIG' });
    const cfgLine = await browser.waitFor(() =>
      browser.frames.find(
        (f) => f.ch === 'acp' && String(f.data).startsWith('env:'),
      ),
    );
    // Browser prefix rewritten to the worker's real --dir.
    expect(String(cfgLine.data)).toBe(
      `env:${workspace}/.metrists/agent/opencode-t1.json`,
    );
    browser.close();
  });

  it('keeps two concurrent tasks’ acp streams apart', async () => {
    const browser = await pair();
    for (const taskId of ['a', 'b']) {
      browser.send({
        ch: 'ctl',
        data: { op: 'start-task', taskId, harnessId: 'scripted', cwd: workspace, extraEnv: {} },
      });
    }
    await browser.waitFor(
      () => browser.frames.filter((f) => f.ch === 'ctl' && (f.data as CtlMessage).op === 'task-started').length === 2,
    );
    browser.send({ ch: 'acp', taskId: 'a', data: 'from-a' });
    browser.send({ ch: 'acp', taskId: 'b', data: 'from-b' });
    await browser.waitFor(() =>
      browser.frames.find(
        (f) => f.ch === 'acp' && f.taskId === 'a' && f.data === 'echo:from-a',
      ),
    );
    await browser.waitFor(() =>
      browser.frames.find(
        (f) => f.ch === 'acp' && f.taskId === 'b' && f.data === 'echo:from-b',
      ),
    );
    // Task a's stream never carried b's line.
    expect(
      browser.frames.filter((f) => f.ch === 'acp' && f.taskId === 'a' && String(f.data).startsWith('echo:')),
    ).toEqual([expect.objectContaining({ data: 'echo:from-a' })]);
    browser.close();
  });

  it('stop-task kills the process and reports its exit', async () => {
    const browser = await pair();
    browser.send({
      ch: 'ctl',
      data: { op: 'start-task', taskId: 't1', harnessId: 'scripted', cwd: workspace, extraEnv: {} },
    });
    await browser.waitFor(() => browser.ctl('task-started'));
    browser.send({ ch: 'ctl', data: { op: 'stop-task', taskId: 't1' } });
    await browser.waitFor(() => browser.ctl('task-exit'));
    browser.close();
  });

  it('bridges MCP relay connections: token gate + connId routing', async () => {
    const browser = await pair();
    browser.send({ ch: 'ctl', data: { op: 'mcp-open', taskId: 't1' } });
    const opened = (await browser.waitFor(() =>
      browser.ctl('mcp-opened'),
    )) as Extract<CtlMessage, { op: 'mcp-opened' }>;
    const mcpPort = Number(opened.mcpServer.args[0]);
    const token = opened.mcpServer.env.find(
      (e) => e.name === 'METRISTS_MCP_TOKEN',
    )!.value;

    // A relay that presents the token round-trips a request line as an mcp
    // frame, and its connId routes the reply back to the same socket.
    const relay = net.connect(mcpPort, '127.0.0.1');
    const relayLines: string[] = [];
    let tail = '';
    relay.on('data', (chunk) => {
      const parts = (tail + chunk.toString()).split('\n');
      tail = parts.pop() ?? '';
      relayLines.push(...parts.filter(Boolean));
    });
    await new Promise<void>((resolve) => relay.on('connect', () => resolve()));
    relay.write(`${token}\n`);
    relay.write('{"jsonrpc":"2.0","id":1}\n');

    const frame = await browser.waitFor(() =>
      browser.frames.find((f) => f.ch === 'mcp' && f.taskId === 't1'),
    );
    expect(frame.data).toBe('{"jsonrpc":"2.0","id":1}');
    browser.send({ ch: 'mcp', taskId: 't1', connId: frame.connId!, data: '{"result":"ok"}' });
    await browser.waitFor(() =>
      relayLines.includes('{"result":"ok"}') ? true : undefined,
    );

    // A relay that presents the wrong token is dropped.
    const evil = net.connect(mcpPort, '127.0.0.1');
    await new Promise<void>((resolve) => evil.on('connect', () => resolve()));
    evil.write('wrong-token\n');
    await browser.waitFor(() => (evil.destroyed ? true : undefined));

    relay.destroy();
    browser.close();
  });

  it('kills tasks when the peer disconnects and accepts a new pairing', async () => {
    const browser = await pair();
    browser.send({
      ch: 'ctl',
      data: {
        op: 'start-task',
        taskId: 't1',
        harnessId: 'scripted',
        cwd: workspace,
        extraEnv: {},
      },
    });
    await browser.waitFor(() => browser.ctl('task-started'));
    browser.close();

    // Reconnect: fresh pairing works, and the old task is gone (a new
    // start-task under the same id succeeds — the worker was cleared).
    await new Promise((r) => setTimeout(r, 200));
    const second = await pair();
    second.send({
      ch: 'ctl',
      data: {
        op: 'start-task',
        taskId: 't1',
        harnessId: 'scripted',
        cwd: workspace,
        extraEnv: {},
      },
    });
    await second.waitFor(() => second.ctl('task-started'));
    second.close();
  });
});
