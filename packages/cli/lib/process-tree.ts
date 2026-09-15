import { spawn, type ChildProcess } from 'child_process';

/**
 * Take down a spawned harness and everything it started.
 *
 * `child.kill()` signals the direct child only. That is not enough here: a
 * harness command is typically an `npx` wrapper that spawns the real adapter,
 * so signalling the wrapper leaves the adapter running, detached from anything
 * that would clean it up. Killing the process *group* reaches both.
 *
 * The caller's side of the bargain is spawning with `detached: true` on POSIX
 * (see `DETACH_FOR_TREE_KILL`), which is what puts the child in a group of its
 * own — without it, `-pid` would signal this process's own group and take the
 * CLI down with the harness.
 *
 * One copy for both spawn sites. The agent host had this; the worker had
 * `child.kill()` and the orphan bug, which is what two implementations of the
 * same decision buys you.
 */
export function killProcessTree(
  child: ChildProcess,
  signal: NodeJS.Signals,
): void {
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

/**
 * Spawn option that makes `killProcessTree` meaningful. Windows has no
 * process groups in this sense and uses taskkill /T instead, so it stays
 * attached there.
 *
 * A detached child does NOT die with its parent, so every spawner using this
 * must have an explicit teardown path. Both do: the agent host tears down in
 * `runHeadlessTurn`'s `finally`, and the worker in `stop()` → `teardownPeer()`,
 * which the agent command wires to SIGINT and SIGTERM.
 */
export const DETACH_FOR_TREE_KILL = process.platform !== 'win32';
