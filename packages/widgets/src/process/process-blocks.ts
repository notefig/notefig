/**
 * Every process block's state, by `blobId` — the process blocks' sibling of
 * the prompt widgets service (../prompt/widgets-service.ts), and like it
 * the one place that state lives, so a block remounted by a re-parse comes
 * back to the same output.
 *
 * A block is the app's: an agent starts it, and the app registers its
 * command under an id it mints. The registry is the app's to keep (handed
 * in); this service reads it, so a block's command is the registered one
 * and an id with no registration is no block at all.
 *
 * A block shows its process's stdout while the stream lasts. The stream is
 * gone once the process exits and its tail has been read, and it was never
 * there for a block read from the file (processes belong to one run of the
 * app). Either way the block can run its command again: `run` starts it
 * only when the stream is gone, so a run can't stack a second process on a
 * live one. Nothing runs without being asked — a file that holds a block
 * must not start a command by being opened. A live one can be stopped.
 *
 * Output is a tail: the newest `MAX_LINES` lines, each cut at
 * `MAX_LINE_LENGTH`, so a long or chatty process holds a bounded amount of
 * memory; what scrolls off the top is counted, not kept. Lines land in
 * batches, so a chatty process re-renders its block a few times a second,
 * not once a line.
 */

/** A spawned process, as the platform hands it over: its stdout lines and
 *  its end. The agents' stdio transport is one. */
export interface ProcessStream {
  start(): Promise<void>;
  onLine(callback: (line: string) => void): () => void;
  onClose(callback: () => void): () => void;
  /** Kill it (its whole process tree); `onClose` follows. */
  close(): Promise<void>;
}

export type SpawnProcess = (spec: {
  procId: string;
  command: string;
  cwd: string;
}) => ProcessStream;

/** A block as the app registered it. */
export type RegisteredProcess = { command: string; cwd: string };

/** The app's registrations, as this service reads them. */
export interface ProcessRegistry {
  /** Resolves once `get` answers for every registered block. */
  load(): Promise<void>;
  get(blobId: string): RegisteredProcess | undefined;
}

export type ProcessBlock = {
  /** The registered command; null for an id the app never minted, and
   *  undefined until the registry has loaded, when neither is known. */
  command: string | null | undefined;
  /** True while the process's stdout stream is live. */
  running: boolean;
  /** Its last `MAX_LINES` lines of stdout, oldest first. */
  lines: readonly string[];
  /** How many earlier lines this run has discarded. */
  dropped: number;
};

export interface ProcessBlocksApi {
  /** Stable: the same object until the block changes. */
  get(blobId: string): ProcessBlock;
  subscribe(blobId: string, onChange: () => void): () => void;
  /** Resolves once every block's `command` is known; starts the loading. */
  loaded(): Promise<void>;
  /** Start the block's registered command, unless its stream is still live. */
  run(blobId: string): void;
  /** Kill the block's process, if it runs. */
  stop(blobId: string): void;
}

/** A block's id is its process's, `blob_<procId>`: the one place either
 *  is derived from the other. */
const BLOB_PREFIX = "blob_";
export const processBlobId = (procId: string) => `${BLOB_PREFIX}${procId}`;
const procIdOf = (blobId: string) => blobId.slice(BLOB_PREFIX.length);

/** Output kept per block; older lines scroll away. */
export const MAX_LINES = 500;
/** A longer line (a minified bundle, a progress bar with no newline) is cut. */
export const MAX_LINE_LENGTH = 2000;
/** How often a running block's new lines land, at most. */
export const FLUSH_MS = 50;

const LOADING: ProcessBlock = {
  command: undefined,
  running: false,
  lines: [],
  dropped: 0,
};

export function createProcessBlocks(deps: {
  spawn: SpawnProcess;
  registry: ProcessRegistry;
}): ProcessBlocksApi {
  const blocks = new Map<string, ProcessBlock>();
  /** Each run's stream, once it has started. */
  const streams = new Map<string, Promise<ProcessStream>>();
  const listeners = new Map<string, Set<() => void>>();
  let loading: Promise<void> | null = null;
  let isLoaded = false;

  // Remembered on first read, so the snapshot stays the same object.
  const get = (blobId: string) => {
    if (!isLoaded) return LOADING;
    let block = blocks.get(blobId);
    if (!block) {
      const command = deps.registry.get(blobId)?.command ?? null;
      blocks.set(
        blobId,
        (block = { command, running: false, lines: [], dropped: 0 }),
      );
    }
    return block;
  };
  const notify = (blobId: string) => {
    for (const listener of listeners.get(blobId) ?? []) listener();
  };
  const update = (blobId: string, change: Partial<ProcessBlock>) => {
    blocks.set(blobId, { ...get(blobId), ...change });
    notify(blobId);
  };
  const loaded = () =>
    (loading ??= deps.registry.load().then(() => {
      isLoaded = true;
      // Every block read while loading now has its answer.
      for (const blobId of listeners.keys()) notify(blobId);
    }));

  return {
    get,
    subscribe(blobId, onChange) {
      // A registry that can't load leaves every block unknown: hidden, and
      // never dropped.
      loaded().catch(() => {});
      const set = listeners.get(blobId) ?? new Set();
      listeners.set(blobId, set);
      set.add(onChange);
      return () => set.delete(onChange);
    },
    loaded,
    run(blobId) {
      const cwd = deps.registry.get(blobId)?.cwd;
      const { command, running } = get(blobId);
      if (!command || cwd === undefined || running) return;
      update(blobId, { running: true, lines: [], dropped: 0 });
      let pending: string[] = [];
      let timer: ReturnType<typeof setTimeout> | undefined;
      const flush = () => {
        timer = undefined;
        const { lines, dropped } = get(blobId);
        const all = [...lines, ...pending];
        pending = [];
        const kept = all.slice(-MAX_LINES);
        update(blobId, {
          lines: kept,
          dropped: dropped + all.length - kept.length,
        });
      };
      const started = Promise.resolve().then(() => {
        const stream = deps.spawn({
          procId: procIdOf(blobId),
          command,
          cwd,
        });
        stream.onLine((line) => {
          pending.push(line.slice(0, MAX_LINE_LENGTH));
          timer ??= setTimeout(flush, FLUSH_MS);
        });
        stream.onClose(() => {
          clearTimeout(timer);
          flush();
          streams.delete(blobId);
          update(blobId, { running: false });
        });
        return stream.start().then(() => stream);
      });
      streams.set(blobId, started);
      // A spawn that throws (no processes on this platform) or a start that
      // rejects both end the run with the reason as its output.
      started.catch((error: unknown) =>
        update(blobId, {
          running: false,
          lines: [error instanceof Error ? error.message : String(error)],
        }),
      );
    },
    stop(blobId) {
      // Stopped while starting, it closes once started: closed sooner, the
      // kill finds no child yet and the start launches the command anyway.
      void streams.get(blobId)?.then(
        (stream) => stream.close(),
        () => {},
      );
    },
  };
}

/** No app behind it: blocks never show or run (tests, schema-only editors). */
export function inertProcessBlocks(): ProcessBlocksApi {
  return {
    get: () => LOADING,
    subscribe: () => () => {},
    // Never: with no registry nothing is known, so nothing is dropped.
    loaded: () => new Promise(() => {}),
    run: () => {},
    stop: () => {},
  };
}
