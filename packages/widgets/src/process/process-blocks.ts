/**
 * Every process block's state, by `blobId` — the process blocks' sibling of
 * the prompt widgets service (../prompt/widgets-service.ts), and like it
 * the one place that state lives, so a block remounted by a re-parse comes
 * back to the same output.
 *
 * A block shows its process's stdout while the stream lasts. The stream is
 * gone once the process exits and its tail has been read, and it was never
 * there for a block read from the file (processes belong to one run of the
 * app). Either way the block can run its command again: `run` starts it
 * only when the stream is gone, so a restart can't stack a second process
 * on a live one. Nothing runs without the user asking — a file that holds
 * a block must not start a command by being opened.
 */

/** A spawned process, as the platform hands it over: its stdout lines and
 *  its end. The agents' stdio transport is one. */
export interface ProcessStream {
  start(): Promise<void>;
  onLine(callback: (line: string) => void): () => void;
  onClose(callback: () => void): () => void;
}

export type SpawnProcess = (spec: {
  procId: string;
  command: string;
  cwd: string;
}) => ProcessStream;

export type ProcessBlock = {
  /** True while the process's stdout stream is live. */
  running: boolean;
  /** Its last `MAX_LINES` lines of stdout, oldest first. */
  lines: readonly string[];
};

export interface ProcessBlocksApi {
  /** Stable: the same object until the block changes. */
  get(blobId: string): ProcessBlock;
  subscribe(blobId: string, onChange: () => void): () => void;
  /** Start the block's command, unless its stream is still live. */
  run(blobId: string, spec: { command: string; cwd: string }): void;
}

/** Output kept per block; older lines scroll away. */
export const MAX_LINES = 500;

const IDLE: ProcessBlock = { running: false, lines: [] };

export function createProcessBlocks(deps: {
  spawn: SpawnProcess;
}): ProcessBlocksApi {
  const blocks = new Map<string, ProcessBlock>();
  const listeners = new Map<string, Set<() => void>>();

  const get = (blobId: string) => blocks.get(blobId) ?? IDLE;
  const update = (blobId: string, change: Partial<ProcessBlock>) => {
    blocks.set(blobId, { ...get(blobId), ...change });
    for (const listener of listeners.get(blobId) ?? []) listener();
  };

  return {
    get,
    subscribe(blobId, onChange) {
      const set = listeners.get(blobId) ?? new Set();
      listeners.set(blobId, set);
      set.add(onChange);
      return () => set.delete(onChange);
    },
    run(blobId, { command, cwd }) {
      if (get(blobId).running) return;
      update(blobId, { running: true, lines: [] });
      // A spawn that throws (no processes on this platform) or a start that
      // rejects both end the run with the reason as its output.
      Promise.resolve()
        .then(() => {
          const stream = deps.spawn({ procId: blobId, command, cwd });
          stream.onLine((line) =>
            update(blobId, { lines: [...get(blobId).lines, line].slice(-MAX_LINES) }),
          );
          stream.onClose(() => update(blobId, { running: false }));
          return stream.start();
        })
        .catch((error: unknown) =>
          update(blobId, {
            running: false,
            lines: [error instanceof Error ? error.message : String(error)],
          }),
        );
    },
  };
}

/** No platform behind it: blocks never run (tests, schema-only editors). */
export function inertProcessBlocks(): ProcessBlocksApi {
  return {
    get: () => IDLE,
    subscribe: () => () => {},
    run: () => {},
  };
}
