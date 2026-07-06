/**
 * Spawn the configured ACP harness adapter as a child process and pipe its
 * newline-delimited JSON-RPC stdio to/from the tunnel's "acp" channel,
 * passing every line through the fs-interceptor first.
 */
import type { HarnessDefinition } from '@metrists/shared';

export type SpawnedHarness = {
  send: (line: string) => void;
  onLine: (callback: (line: string) => void) => () => void;
  kill: () => Promise<void>;
};

export async function spawnHarness(
  _harness: HarnessDefinition,
  _cwd: string,
): Promise<SpawnedHarness> {
  // TODO(phase 3): child_process.spawn with piped stdio, line buffering,
  // kill on tunnel close.
  throw new Error('not implemented: spawnHarness');
}
