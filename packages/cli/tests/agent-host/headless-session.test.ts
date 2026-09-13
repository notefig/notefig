/**
 * The whole point of MET-182, as a test: a real NotefigAcpClient runs a
 * scripted ACP session from a Node process, with no app, no webview, and no
 * harness installed.
 */
import { describe, expect, it } from '@jest/globals';
import * as os from 'os';
import * as path from 'path';
import { promises as fs } from 'fs';
import { createLoopbackPair } from '../../lib/agent';
import {
  HeadlessSessionError,
  TurnCancelledError,
  findHarness,
  runHeadlessTurn,
} from '../../lib/agent-host/headless-session';
import { createNodeFileSystem } from '../../lib/agent-host/node-fs';
import { createAcpFileSystem, FsError } from '../../lib/core';
import { posix } from '../../lib/shared';
import {
  attachCancellableAgent,
  attachScriptedAgent,
} from './scripted-agent';
import { newTaskId, type SessionNotification } from '../../lib/shared';

/** Observe transport teardown without reimplementing close(). */
function trackClose(
  transport: { close(): Promise<void> },
  onClose: () => void,
): void {
  const original = transport.close.bind(transport);
  transport.close = async () => {
    onClose();
    await original();
  };
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'notefig-session-'));
  try {
    return await fn(await fs.realpath(dir));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe('runHeadlessTurn', () => {
  it('drives a full session and streams updates to completion', async () => {
    await withTempDir(async (dir) => {
      const prompts: any[] = [];
      const updates: SessionNotification[] = [];

      const outcome = await runHeadlessTurn({
        taskId: newTaskId(),
        harnessId: 'claude-code',
        workspacePath: dir,
        prompt: 'summarize the repo',
        onUpdate: (notification) => updates.push(notification),
        createTransport: () => {
          const [clientSide, agentSide] = createLoopbackPair();
          attachScriptedAgent(agentSide, {
            turns: [
              {
                chunks: ['Hello', ' world'],
                onPrompt: (params) => prompts.push(params),
              },
            ],
          });
          return clientSide;
        },
      });

      expect(outcome.stopReason).toBe('end_turn');
      // The prompt reached the agent as an ACP content block.
      expect(prompts).toHaveLength(1);
      expect(prompts[0].prompt).toEqual([
        { type: 'text', text: 'summarize the repo' },
      ]);
      // And its output streamed back through the real client.
      const texts = updates
        .map((n: any) => n.update?.content?.text)
        .filter(Boolean);
      expect(texts).toEqual(['Hello', ' world']);
    });
  });

  it('passes the workspace as the session cwd', async () => {
    await withTempDir(async (dir) => {
      let sessionCwd: string | undefined;
      await runHeadlessTurn({
        taskId: newTaskId(),
        harnessId: 'claude-code',
        workspacePath: dir,
        prompt: 'hi',
        onUpdate: () => undefined,
        createTransport: () => {
          const [clientSide, agentSide] = createLoopbackPair();
          agentSide.onLine((line) => {
            const message = JSON.parse(line);
            if (message.method === 'session/new') {
              sessionCwd = message.params?.cwd;
            }
          });
          attachScriptedAgent(agentSide, { turns: [{}] });
          return clientSide;
        },
      });
      expect(sessionCwd).toBe(dir);
    });
  });

  it('sends no MCP servers — app tools are out of scope for this host', async () => {
    await withTempDir(async (dir) => {
      let mcpServers: unknown;
      await runHeadlessTurn({
        taskId: newTaskId(),
        harnessId: 'claude-code',
        workspacePath: dir,
        prompt: 'hi',
        onUpdate: () => undefined,
        createTransport: () => {
          const [clientSide, agentSide] = createLoopbackPair();
          agentSide.onLine((line) => {
            const message = JSON.parse(line);
            if (message.method === 'session/new') {
              mcpServers = message.params?.mcpServers;
            }
          });
          attachScriptedAgent(agentSide, { turns: [{}] });
          return clientSide;
        },
      });
      expect(mcpServers).toEqual([]);
    });
  });

  it('surfaces a mid-turn transport death instead of hanging', async () => {
    await withTempDir(async (dir) => {
      await expect(
        runHeadlessTurn({
          taskId: newTaskId(),
          harnessId: 'claude-code',
          workspacePath: dir,
          prompt: 'hi',
          onUpdate: () => undefined,
          createTransport: () => {
            const [clientSide, agentSide] = createLoopbackPair();
            // Answers initialize and session/new, then dies during the turn.
            attachScriptedAgent(agentSide, { turns: [] });
            agentSide.onLine((line) => {
              if (JSON.parse(line).method === 'session/prompt') {
                void agentSide.close();
              }
            });
            return clientSide;
          },
        }),
      ).rejects.toBeInstanceOf(HeadlessSessionError);
    });
  });

  // Regression: the first cut of the CLI's signal handler only printed
  // "Cancelling..." — the turn kept awaiting prompt(), so teardown never ran
  // and the harness tree survived Ctrl-C (verified against a real harness).
  it('cancels through the protocol and closes the transport', async () => {
    await withTempDir(async (dir) => {
      const controller = new AbortController();
      let sawCancel = () => false;
      let closed = false;

      const outcome = await runHeadlessTurn({
        taskId: newTaskId(),
        harnessId: 'claude-code',
        workspacePath: dir,
        prompt: 'long task',
        onUpdate: () => undefined,
        signal: controller.signal,
        createTransport: () => {
          const [clientSide, agentSide] = createLoopbackPair();
          trackClose(clientSide, () => (closed = true));
          // An adapter that honours session/cancel: it parks the prompt and
          // ends the turn itself once told to stop.
          const agent = attachCancellableAgent(agentSide);
          sawCancel = agent.sawCancel;
          setTimeout(() => controller.abort(), 0);
          return clientSide;
        },
      });

      expect(sawCancel()).toBe(true);
      expect(outcome.stopReason).toBe('cancelled');
      expect(closed).toBe(true);
    });
  });

  it('forces teardown when the harness ignores the cancel', async () => {
    await withTempDir(async (dir) => {
      const controller = new AbortController();
      let closed = false;

      await expect(
        runHeadlessTurn({
          taskId: newTaskId(),
          harnessId: 'claude-code',
          workspacePath: dir,
          prompt: 'long task',
          onUpdate: () => undefined,
          signal: controller.signal,
          createTransport: () => {
            const [clientSide, agentSide] = createLoopbackPair();
            trackClose(clientSide, () => (closed = true));
            // Answers the handshake, then goes deaf — never ends the turn,
            // never acknowledges the cancel.
            attachScriptedAgent(agentSide, { turns: [] });
            agentSide.onLine((line) => {
              if (JSON.parse(line).method === 'session/prompt') {
                setImmediate(() => controller.abort());
              }
            });
            return clientSide;
          },
        }),
      ).rejects.toBeInstanceOf(TurnCancelledError);

      // The point of the grace timer: teardown happens anyway.
      expect(closed).toBe(true);
    });
  }, 15_000);

  it('aborts during startup, before a session exists', async () => {
    await withTempDir(async (dir) => {
      const controller = new AbortController();
      let closed = false;

      await expect(
        runHeadlessTurn({
          taskId: newTaskId(),
          harnessId: 'claude-code',
          workspacePath: dir,
          prompt: 'hi',
          onUpdate: () => undefined,
          signal: controller.signal,
          createTransport: () => {
            const [clientSide, agentSide] = createLoopbackPair();
            trackClose(clientSide, () => (closed = true));
            // An adapter that wedges on `initialize` — there is no session to
            // cancel, so the abort has to work on the startup phase itself.
            agentSide.onLine(() => setImmediate(() => controller.abort()));
            return clientSide;
          },
        }),
      ).rejects.toBeInstanceOf(TurnCancelledError);

      expect(closed).toBe(true);
    });
  });

  it('rejects an unknown harness with the available ids', async () => {
    expect(() => findHarness('not-a-harness')).toThrow(HeadlessSessionError);
    expect(() => findHarness('not-a-harness')).toThrow(/Available:/);
  });
});

describe('the ACP bridge over the Node file system', () => {
  // The core owns the protocol rules and is unit-tested there with a fake
  // file system. These run the same bridge over real disk, so the two layers
  // are proven to compose rather than only to typecheck.
  const bridgeFor = (dir: string) =>
    createAcpFileSystem(createNodeFileSystem(), {
      workspacePath: dir,
      path: posix,
    });

  it('reads and writes inside the workspace', async () => {
    await withTempDir(async (dir) => {
      const acpFs = bridgeFor(dir);
      await acpFs.writeTextFile(path.join(dir, 'notes/a.md'), 'one\ntwo\n');
      expect(await acpFs.readTextFile(path.join(dir, 'notes/a.md'))).toBe(
        'one\ntwo\n',
      );
    });
  });

  it('creates parent directories for a harness-invented path', async () => {
    await withTempDir(async (dir) => {
      await bridgeFor(dir).writeTextFile(
        path.join(dir, 'deep/deeper/new.md'),
        'body',
      );
      expect(
        await fs.readFile(path.join(dir, 'deep/deeper/new.md'), 'utf8'),
      ).toBe('body');
    });
  });

  it('applies 1-based line/limit slicing like the desktop host', async () => {
    await withTempDir(async (dir) => {
      const acpFs = bridgeFor(dir);
      const file = path.join(dir, 'lines.txt');
      await acpFs.writeTextFile(file, 'a\nb\nc\nd\ne');
      expect(await acpFs.readTextFile(file, { line: 2, limit: 2 })).toBe('b\nc');
      expect(await acpFs.readTextFile(file, { line: 4 })).toBe('d\ne');
    });
  });

  it('resolves a workspace-relative path the harness sends', async () => {
    await withTempDir(async (dir) => {
      const acpFs = bridgeFor(dir);
      await acpFs.writeTextFile('relative.md', 'from a relative path');
      expect(await fs.readFile(path.join(dir, 'relative.md'), 'utf8')).toBe(
        'from a relative path',
      );
    });
  });

  it('refuses paths that escape the workspace', async () => {
    await withTempDir(async (dir) => {
      const acpFs = bridgeFor(dir);
      await expect(
        acpFs.readTextFile(path.join(dir, '..', 'escaped.txt')),
      ).rejects.toThrow(/outside the workspace/);
      await expect(acpFs.writeTextFile('/etc/passwd', 'nope')).rejects.toThrow(
        /outside the workspace/,
      );
    });
  });

  it('reports a missing file as FsError, not an errno stack', async () => {
    await withTempDir(async (dir) => {
      const error = await bridgeFor(dir)
        .readTextFile(path.join(dir, 'nope.md'))
        .catch((e) => e);
      expect(error).toBeInstanceOf(FsError);
      expect(error.type).toBe('not_found');
    });
  });
});
