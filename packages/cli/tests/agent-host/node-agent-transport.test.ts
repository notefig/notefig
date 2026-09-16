/**
 * The Node `proc` adapter, exercised against trivial node processes rather
 * than a real harness — so this runs in CI with no external tooling
 * installed. What matters is the AgentTransport contract: lines in, lines
 * out, close reported, and no surviving grandchildren.
 */
import { describe, expect, it } from '@jest/globals';
import { NodeAgentTransport } from '../../lib/agent-host/node-agent-transport';
import { AgentTransportError } from '../../lib/agent';
import type { HarnessDefinition } from '../../lib/shared';
import * as os from 'os';
import { promises as fs } from 'fs';
import * as path from 'path';

/** A harness definition whose "adapter" is an inline node script. */
function scriptHarness(script: string): HarnessDefinition {
  return {
    id: 'test-script',
    command: process.execPath,
    args: ['-e', script],
    env: {},
  } as unknown as HarnessDefinition;
}

/** An echo adapter: every line in comes back wrapped, so we can prove the
 *  full stdin→stdout round trip through the transport's framing. */
const ECHO_SCRIPT = `
  let buf = '';
  process.stdin.on('data', (c) => {
    buf += c.toString();
    let i;
    while ((i = buf.indexOf('\\n')) !== -1) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line) process.stdout.write('echo:' + line + '\\n');
    }
  });
`;

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'notefig-proc-'));
  try {
    return await fn(await fs.realpath(dir));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe('NodeAgentTransport', () => {
  it('round-trips lines through the child process stdio', async () => {
    await withTempDir(async (dir) => {
      const transport = new NodeAgentTransport({
        harness: scriptHarness(ECHO_SCRIPT),
        workspacePath: dir,
      });
      const lines: string[] = [];
      transport.onLine((line) => lines.push(line));

      await transport.start();
      transport.send('{"jsonrpc":"2.0","id":1}');
      transport.send('second');

      await waitFor(() => lines.length === 2);
      expect(lines).toEqual(['echo:{"jsonrpc":"2.0","id":1}', 'echo:second']);

      await transport.close();
    });
  });

  it('reassembles lines split across stdout chunks', async () => {
    await withTempDir(async (dir) => {
      // Emit one logical line in three writes with a gap, so the transport's
      // buffering — not luck — is what produces a single line.
      const transport = new NodeAgentTransport({
        harness: scriptHarness(`
          process.stdout.write('{"par');
          setTimeout(() => process.stdout.write('tial":'), 10);
          setTimeout(() => process.stdout.write('true}\\n'), 20);
        `),
        workspacePath: dir,
      });
      const lines: string[] = [];
      transport.onLine((line) => lines.push(line));

      await transport.start();
      await waitFor(() => lines.length === 1);
      expect(lines).toEqual(['{"partial":true}']);

      await transport.close();
    });
  });

  it('spawns in the workspace directory', async () => {
    await withTempDir(async (dir) => {
      const transport = new NodeAgentTransport({
        harness: scriptHarness(`process.stdout.write(process.cwd() + '\\n')`),
        workspacePath: dir,
      });
      const lines: string[] = [];
      transport.onLine((line) => lines.push(line));

      await transport.start();
      await waitFor(() => lines.length === 1);
      // realpath: macOS /var → /private/var.
      expect(await fs.realpath(lines[0])).toBe(dir);

      await transport.close();
    });
  });

  it('applies harness env and strips CLAUDECODE', async () => {
    await withTempDir(async (dir) => {
      process.env.CLAUDECODE = '1';
      const harness = {
        ...scriptHarness(
          `process.stdout.write(JSON.stringify({
             fromHarness: process.env.FROM_HARNESS ?? null,
             fromTask: process.env.FROM_TASK ?? null,
             claudecode: process.env.CLAUDECODE ?? null,
           }) + '\\n')`,
        ),
        env: { FROM_HARNESS: 'yes' },
      } as HarnessDefinition;

      const transport = new NodeAgentTransport({
        harness,
        workspacePath: dir,
        extraEnv: { FROM_TASK: 'also' },
      });
      const lines: string[] = [];
      transport.onLine((line) => lines.push(line));

      await transport.start();
      await waitFor(() => lines.length === 1);
      expect(JSON.parse(lines[0])).toEqual({
        fromHarness: 'yes',
        fromTask: 'also',
        claudecode: null,
      });

      await transport.close();
      delete process.env.CLAUDECODE;
    });
  });

  it('reports an unexpected exit through onClose', async () => {
    await withTempDir(async (dir) => {
      const transport = new NodeAgentTransport({
        harness: scriptHarness(`process.exit(3)`),
        workspacePath: dir,
      });
      const closed = new Promise<AgentTransportError | undefined>((resolve) => {
        transport.onClose(resolve);
      });

      await transport.start();
      const error = await closed;
      expect(error).toBeInstanceOf(AgentTransportError);
      expect(error?.type).toBe('closed');

      await transport.close();
    });
  });

  it('rejects with spawn_failed when the binary does not exist', async () => {
    await withTempDir(async (dir) => {
      const transport = new NodeAgentTransport({
        harness: {
          id: 'missing',
          command: 'notefig-no-such-binary-xyz',
          args: [],
          env: {},
        } as unknown as HarnessDefinition,
        workspacePath: dir,
      });

      await expect(transport.start()).rejects.toMatchObject({
        name: 'AgentTransportError',
        type: 'spawn_failed',
      });
    });
  });

  it('exposes spawnInfo after start', async () => {
    await withTempDir(async (dir) => {
      const transport = new NodeAgentTransport({
        harness: scriptHarness(ECHO_SCRIPT),
        workspacePath: dir,
      });
      expect(transport.spawnInfo).toBeUndefined();

      await transport.start();
      expect(transport.spawnInfo?.pid).toEqual(expect.any(Number));
      expect(transport.spawnInfo?.program).toBe(process.execPath);
      expect(transport.spawnInfo?.cwd).toBe(dir);

      await transport.close();
    });
  });

  it('close() is idempotent and safe before start', async () => {
    await withTempDir(async (dir) => {
      const transport = new NodeAgentTransport({
        harness: scriptHarness(ECHO_SCRIPT),
        workspacePath: dir,
      });
      await expect(transport.close()).resolves.toBeUndefined();

      await transport.start();
      await transport.close();
      await expect(transport.close()).resolves.toBeUndefined();
    });
  });

  // The orphan case the desktop host documents (agent_proc.rs:112-118): the
  // built-in harnesses are npx wrappers, so killing only the direct child
  // leaves the real adapter running, reparented to init.
  (process.platform === 'win32' ? it.skip : it)(
    'kills grandchildren, not just the spawned process',
    async () => {
      await withTempDir(async (dir) => {
        const marker = path.join(dir, 'grandchild.pid');
        // Parent spawns a long-lived grandchild and records its pid, then
        // idles. A plain child-only kill would leave the grandchild alive.
        const transport = new NodeAgentTransport({
          harness: scriptHarness(`
            const { spawn } = require('child_process');
            const fs = require('fs');
            const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
            fs.writeFileSync(${JSON.stringify(marker)}, String(child.pid));
            setInterval(() => {}, 1000);
          `),
          workspacePath: dir,
        });

        await transport.start();
        await waitFor(async () => {
          try {
            return (await fs.readFile(marker, 'utf8')).length > 0;
          } catch {
            return false;
          }
        });
        const grandchildPid = Number(await fs.readFile(marker, 'utf8'));
        expect(isAlive(grandchildPid)).toBe(true);

        await transport.close();
        await waitFor(() => !isAlive(grandchildPid));
        expect(isAlive(grandchildPid)).toBe(false);
      });
    },
    15_000,
  );
});

function isAlive(pid: number): boolean {
  try {
    // Signal 0 tests for existence without delivering anything.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for condition');
}
