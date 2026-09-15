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

/** How long a tree gets to exit on SIGTERM before it is SIGKILLed. */
export const KILL_GRACE_MS = 5_000;

/**
 * Ask a harness tree to exit, force it if it does not, and resolve once it is
 * gone — or once the grace window closes, whichever comes first.
 *
 * Both spawners need the identical dance and had it written out twice, which
 * is what let the worker's copy drift into killing only the direct child.
 *
 * Resolving on the grace timer matters: SIGKILL is a request to the kernel,
 * not a guarantee of reaping, and a process wedged in uninterruptible sleep
 * never fires 'exit'. Both callers await this from a teardown path that
 * something else awaits in turn — `runHeadlessTurn`'s `finally`, and
 * `teardownPeer` under the agent command's SIGINT handler — so an unreaped
 * child would hang the caller instead of ending it.
 *
 * 'close' is listened for alongside 'exit' because it is the terminal event
 * Node guarantees for a child that never spawned at all, where 'exit' is
 * never emitted.
 */
export function terminateProcessTree(
  child: ChildProcess,
  graceMs: number = KILL_GRACE_MS,
): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(forceKill);
      resolve();
    };

    const forceKill = setTimeout(() => {
      killProcessTree(child, 'SIGKILL');
      settle();
    }, graceMs);
    // Don't let the grace timer hold the process's event loop open by itself.
    forceKill.unref?.();

    child.once('exit', settle);
    child.once('close', settle);

    killProcessTree(child, 'SIGTERM');
    if (process.platform === 'win32') {
      // No SIGTERM equivalent — go straight to the forced tree kill.
      killProcessTree(child, 'SIGKILL');
    }
  });
}
