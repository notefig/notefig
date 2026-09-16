/**
 * The real command, a real harness process, a real signal.
 *
 * Every way a run is cancelled from outside must end the same way: the turn
 * is cancelled through ACP, the task row is handed back to the app
 * ("restored", no owner), and the database connection is closed. Closure is
 * observable: SQLite removes the WAL files when the last connection closes
 * cleanly. SIGKILL is the control — nothing can run on it — and shows what the
 * app's boot recovers from instead.
 *
 * Needs `npm run build` first, like the other suites that exec dist.
 */
import { describe, expect, it } from '@jest/globals';
import { execFileSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { openSharedDb, type AgentTaskRow } from '../../lib/shared';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const Database = require('better-sqlite3');

const CLI = path.join(__dirname, '..', '..', 'dist', 'bin', 'notefig.js');
const REGISTER = path.join(__dirname, '..', 'fixtures', 'register-waiting-harness.js');

/** The task rows as another connection sees them, read through TanStack. */
async function tasksIn(dbPath: string): Promise<AgentTaskRow[]> {
  const db = openSharedDb(new Database(dbPath, { timeout: 5000 }));
  try {
    return await db.tasks.all();
  } finally {
    await db.close();
  }
}

async function waitFor(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function runUntilPrompted(dir: string) {
  const dbPath = path.join(dir, 'notefig.db');
  const marker = path.join(dir, 'prompted');
  const workspace = path.join(dir, 'ws');
  fs.mkdirSync(workspace);
  execFileSync(process.execPath, [REGISTER, dbPath]);

  const child = spawn(
    process.execPath,
    [CLI, 'agent-run', '--harness', 'waiting', '--dir', workspace, '--prompt', 'wait for me'],
    {
      env: { ...process.env, NOTEFIG_DB_DIR: dir, ACP_WAITING_AGENT_MARKER: marker },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.on('exit', (code, signal) => resolve({ code, signal })),
  );

  await waitFor(() => fs.existsSync(marker), 'the harness to receive the prompt');
  return { child, exited, dbPath, output: () => output };
}

function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'notefig-signals-')));
  return fn(dir).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

describe('agent-run under signals', () => {
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    it(
      `${signal} cancels the turn, hands the task back and closes the database`,
      () =>
        withTempDir(async (dir) => {
          const run = await runUntilPrompted(dir);

          const [during] = await tasksIn(run.dbPath);
          expect(during).toMatchObject({
            harnessId: 'waiting',
            status: 'running',
            sessionId: 'waiting-session-1',
            ownerPid: run.child.pid,
          });

          run.child.kill(signal);
          const { code } = await run.exited;
          expect({ code, output: code === 130 ? '' : run.output() }).toEqual({ code: 130, output: '' });

          // Closed cleanly: SQLite removed the WAL files on the last close.
          expect(fs.existsSync(`${run.dbPath}-wal`)).toBe(false);

          const [after] = await tasksIn(run.dbPath);
          expect(after).toMatchObject({ status: 'restored', sessionId: 'waiting-session-1' });
          expect(after).not.toHaveProperty('ownerPid');
        }),
      30_000,
    );
  }

  it(
    'SIGKILL (control): nothing runs, the row keeps its now-dead owner, the database stays readable',
    () =>
      withTempDir(async (dir) => {
        const run = await runUntilPrompted(dir);
        const pid = run.child.pid;

        run.child.kill('SIGKILL');
        const { signal } = await run.exited;
        expect(signal).toBe('SIGKILL');

        // Not closed: the WAL is still there. Nothing is lost by that — the
        // next connection reads committed state and recovers the file.
        expect(fs.existsSync(`${run.dbPath}-wal`)).toBe(true);
        const [after] = await tasksIn(run.dbPath);
        expect(after).toMatchObject({ status: 'running', ownerPid: pid });
        // Which the app's boot reconcile restores, because this pid is gone.
        expect(() => process.kill(pid!, 0)).toThrow();
      }),
    30_000,
  );
});
