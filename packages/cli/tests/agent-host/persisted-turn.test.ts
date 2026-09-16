/**
 * A headless turn leaves the task row the app expects, at every stage: owned
 * by this process while it runs, and handed back in exactly the shape the
 * app's boot mapping produces when it ends.
 */
import { describe, expect, it } from '@jest/globals';
import * as os from 'os';
import * as path from 'path';
import { promises as fs } from 'fs';
import { createLoopbackPair } from '../../lib/agent';
import { HeadlessSessionError } from '../../lib/agent-host/headless-session';
import { runPersistedHeadlessTurn } from '../../lib/agent-host/persisted-turn';
import {
  HARNESS_OVERRIDES_KEY,
  HARNESS_SETTINGS_NAMESPACE,
  newTaskId,
  openSharedDb,
  type AgentTaskRow,
  type SharedDb,
} from '../../lib/shared';
import { attachScriptedAgent } from './scripted-agent';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const Database = require('better-sqlite3');

/** Every task row as a separate connection sees it, read through TanStack. */
async function tasksIn(dbPath: string): Promise<AgentTaskRow[]> {
  const other = openSharedDb(new Database(dbPath, { timeout: 5000 }));
  try {
    return await other.tasks.all();
  } finally {
    await other.close();
  }
}

async function withSharedDb<T>(fn: (db: SharedDb, dbPath: string, dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'notefig-persisted-turn-')));
  const dbPath = path.join(dir, 'notefig.db');
  const db = openSharedDb(new Database(dbPath, { timeout: 5000 }));
  try {
    return await fn(db, dbPath, dir);
  } finally {
    await db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe('runPersistedHeadlessTurn', () => {
  it('owns the row while running and hands it back restorable', async () => {
    await withSharedDb(async (db, dbPath, dir) => {
      const taskId = newTaskId();
      let duringTurn: AgentTaskRow | undefined;

      const outcome = await runPersistedHeadlessTurn({
        db,
        taskId,
        harnessId: 'claude-code',
        workspacePath: dir,
        prompt: 'summarize the repo',
        onUpdate: () => undefined,
        createTransport: () => {
          const [clientSide, agentSide] = createLoopbackPair();
          attachScriptedAgent(agentSide, {
            turns: [
              {
                chunks: ['done'],
                // Mid-turn, as the app would see it: this process's collection
                // already holds the row, so read it back through the store.
                onPrompt: () => {
                  duringTurn = db.tasks.get(taskId);
                },
              },
            ],
          });
          return clientSide;
        },
      });

      expect(outcome.stopReason).toBe('end_turn');
      expect(duringTurn).toMatchObject({
        taskId,
        status: 'running',
        sessionId: 'scripted-session-1',
        ownerPid: process.pid,
        title: 'summarize the repo',
        harnessId: 'claude-code',
        workspacePath: dir,
      });

      // After the turn, from a separate connection — what another process sees.
      const after = (await tasksIn(dbPath)).find((task) => task.taskId === taskId);
      expect(after).toMatchObject({
        taskId,
        status: 'restored',
        sessionId: 'scripted-session-1',
      });
      // Handed back: nothing claims the task any more.
      expect(after).not.toHaveProperty('ownerPid');
    });
  });

  it('deletes the row when no session was ever accepted', async () => {
    await withSharedDb(async (db, dbPath, dir) => {
      const taskId = newTaskId();
      await expect(
        runPersistedHeadlessTurn({
          db,
          taskId,
          harnessId: 'claude-code',
          workspacePath: dir,
          prompt: 'x',
          onUpdate: () => undefined,
          createTransport: () => {
            const [clientSide, agentSide] = createLoopbackPair();
            // The agent goes away before answering initialize.
            agentSide.onLine(() => void agentSide.close());
            return clientSide;
          },
        }),
      ).rejects.toBeInstanceOf(HeadlessSessionError);

      expect((await tasksIn(dbPath)).some((task) => task.taskId === taskId)).toBe(false);
    });
  });

  it('leaves no row for a harness the app has disabled', async () => {
    await withSharedDb(async (db, dbPath, dir) => {
      // What the app's settings screen writes.
      await db.writeKv(HARNESS_SETTINGS_NAMESPACE, HARNESS_OVERRIDES_KEY, {
        'claude-code': { id: 'claude-code', enabled: false },
      });
      const taskId = newTaskId();

      await expect(
        runPersistedHeadlessTurn({
          db,
          taskId,
          harnessId: 'claude-code',
          workspacePath: dir,
          prompt: 'x',
          onUpdate: () => undefined,
        }),
      ).rejects.toThrow(/disabled in your settings/);

      expect((await tasksIn(dbPath)).some((task) => task.taskId === taskId)).toBe(false);
    });
  });

  it('runs without a database, leaving nothing behind', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'notefig-no-db-'));
    try {
      const outcome = await runPersistedHeadlessTurn({
        db: null,
        taskId: newTaskId(),
        harnessId: 'claude-code',
        workspacePath: dir,
        prompt: 'x',
        onUpdate: () => undefined,
        createTransport: () => {
          const [clientSide, agentSide] = createLoopbackPair();
          attachScriptedAgent(agentSide, { turns: [{ chunks: ['ok'] }] });
          return clientSide;
        },
      });
      expect(outcome.stopReason).toBe('end_turn');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
