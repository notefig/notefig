/**
 * The editor ↔ sync link for one document: `core.workspace(ws).sync
 * .document(path)`. Hooks are broadcasts; an open editor needs something
 * richer — ordered, typed, both ways — so each open document gets a
 * channel, CSP style, built from two primitives:
 *
 * - an **ordered stream** (`OrderedStream`): every value, in order, with a
 *   bounded buffer — `send` resolves once the value is buffered, so a slow
 *   reader holds the writer back instead of growing memory;
 * - a **latest value** (`LatestValue`): only the newest value matters
 *   (cursors, presence, lease views). Setting never blocks; a reader that
 *   falls behind skips straight to the newest.
 *
 * Both are async iterables; a reader's `for await` ends when the channel
 * closes.
 *
 * Directions:
 *
 * - sync → editor: `incoming` (ordered) carries remote content that has
 *   been applied to the file. Solo needs only this, and only as a notice:
 *   the documents write path has already adopted it into an open editor
 *   (caret kept, out of the undo history). Shared (MET-271) sends the
 *   same notice for content merged with the editor's own unsaved edits
 *   (`merged: true`): the merge ran in the worker and the result was
 *   adopted the same way. `remoteCursors` and `leases` (latest
 *   value) are the seams for MET-272 presence and MET-273 leases; nothing
 *   sets them in solo.
 * - editor → sync: `cursor` (latest value) is the local caret as block
 *   plus offset; `requestLease` asks for blocks before an edit. Solo
 *   ignores the cursor and grants every lease (there is no one to hold
 *   against); MET-273 gates on the branch CAS.
 *
 * The editor side attaches only at the shared level; in solo nothing new
 * runs in the editor.
 */

/** Ordered values with a bounded buffer. */
export interface OrderedStream<T> extends AsyncIterable<T> {
  /** Buffer `value`; resolves once there is room. Rejects once closed. */
  send(value: T): Promise<void>;
  close(): void;
  readonly closed: boolean;
}

/** Only the newest value counts. */
export interface LatestValue<T> extends AsyncIterable<T> {
  set(value: T): void;
  get(): T | undefined;
  close(): void;
}

class ChannelClosedError extends Error {
  override name = "ChannelClosedError";
}

type Waiter<T> = (result: IteratorResult<T>) => void;

export function createOrderedStream<T>(capacity = 16): OrderedStream<T> {
  const buffer: T[] = [];
  const readers: Waiter<T>[] = [];
  const writers: { resume: () => void; fail: (error: Error) => void }[] = [];
  let closed = false;

  const wakeWriter = () => {
    while (writers.length > 0 && buffer.length < capacity) {
      writers.shift()!.resume();
    }
  };

  const next = (): Promise<IteratorResult<T>> => {
    if (buffer.length > 0) {
      const value = buffer.shift()!;
      wakeWriter();
      return Promise.resolve({ value, done: false });
    }
    if (closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => readers.push(resolve));
  };

  return {
    get closed() {
      return closed;
    },
    async send(value) {
      if (closed) throw new ChannelClosedError("The channel is closed.");
      const reader = readers.shift();
      if (reader) {
        reader({ value, done: false });
        return;
      }
      if (buffer.length >= capacity) {
        await new Promise<void>((resume, fail) => writers.push({ resume, fail }));
      }
      buffer.push(value);
    },
    close() {
      if (closed) return;
      closed = true;
      for (const reader of readers.splice(0)) {
        reader({ value: undefined, done: true });
      }
      for (const writer of writers.splice(0)) {
        writer.fail(new ChannelClosedError("The channel is closed."));
      }
    },
    [Symbol.asyncIterator]: () => ({ next }),
  };
}

export function createLatestValue<T>(): LatestValue<T> {
  let current: { value: T } | null = null;
  let version = 0;
  let closed = false;
  const readers = new Set<() => void>();

  return {
    set(value) {
      if (closed) return;
      current = { value };
      version += 1;
      for (const wake of [...readers]) wake();
    },
    get: () => current?.value,
    close() {
      closed = true;
      for (const wake of [...readers]) wake();
    },
    [Symbol.asyncIterator]() {
      let seen = 0;
      return {
        next: async (): Promise<IteratorResult<T>> => {
          while (!closed && version === seen) {
            await new Promise<void>((wake) => {
              const done = () => {
                readers.delete(done);
                wake();
              };
              readers.add(done);
            });
          }
          if (closed || !current) return { value: undefined, done: true };
          seen = version;
          return { value: current.value, done: false };
        },
      };
    },
  };
}

// --- The channel's vocabulary ------------------------------------------------

/** Remote content that reached the document. */
export interface SyncIncomingContent {
  kind: "applied";
  /** The file's text now. */
  content: string;
  /** The branch commit it came from. */
  commit: string;
  /** Whether an open editor adopted it (false: it had unsaved edits). */
  adopted: boolean;
  /** The content is local edits merged with the remote's (MET-271). */
  merged?: boolean;
}

/** A position as block plus offset, relative to a branch commit, so every
 *  client resolves it the same way (MET-266 decision 19). */
export interface SyncBlockAnchor {
  commit: string;
  blockIndex: number;
  offset: number;
}

/** The local caret and selection. */
export interface SyncCursor {
  anchor: SyncBlockAnchor;
  head: SyncBlockAnchor;
}

/** Another device's (or agent's) caret (MET-272). */
export interface SyncRemoteCursor extends SyncCursor {
  holderId: string;
  name: string;
  color: string;
  agent?: { taskId: string; harness: string };
}

/** A leased block as the editor draws it (MET-273). */
export interface SyncLeaseView {
  blockIndex: number;
  holderId: string;
  name: string;
  color: string;
  mine: boolean;
}

export type SyncLeaseOutcome =
  | { granted: true }
  | { granted: false; holders: { name: string; holderId: string }[] };

/** The per-document link between an open editor and sync. */
export interface SyncDocumentChannel {
  readonly path: string;
  /** sync → editor, ordered. */
  readonly incoming: AsyncIterable<SyncIncomingContent>;
  /** sync → editor, latest value: the others' carets (MET-272). */
  readonly remoteCursors: AsyncIterable<SyncRemoteCursor[]>;
  /** sync → editor, latest value: who holds which block (MET-273). */
  readonly leases: AsyncIterable<SyncLeaseView[]>;
  /** editor → sync, latest value wins. */
  setCursor(cursor: SyncCursor | null): void;
  /** editor → sync: ask for blocks before editing them. */
  requestLease(blockIndexes: number[]): Promise<SyncLeaseOutcome>;
  /** Detach: the streams end for every reader. */
  close(): void;
}

/** Sync's end of one document's channel. */
export interface SyncDocumentPort {
  readonly channel: SyncDocumentChannel;
  /** Deliver remote content, in order. */
  deliver(event: SyncIncomingContent): Promise<void>;
  remoteCursors: LatestValue<SyncRemoteCursor[]>;
  leases: LatestValue<SyncLeaseView[]>;
  /** The editor's latest caret. */
  cursor: LatestValue<SyncCursor | null>;
  readonly closed: boolean;
}

/**
 * Both ends of a document's channel. `grantLease` is the level's lease
 * rule: solo grants everything.
 */
export function createDocumentPort(
  path: string,
  options: {
    grantLease?: (blocks: number[]) => Promise<SyncLeaseOutcome>;
    onClose?: () => void;
  } = {},
): SyncDocumentPort {
  const incoming = createOrderedStream<SyncIncomingContent>();
  const remoteCursors = createLatestValue<SyncRemoteCursor[]>();
  const leases = createLatestValue<SyncLeaseView[]>();
  const cursor = createLatestValue<SyncCursor | null>();
  const grantLease =
    options.grantLease ?? (async () => ({ granted: true }) as const);
  let closed = false;

  const channel: SyncDocumentChannel = {
    path,
    incoming,
    remoteCursors,
    leases,
    setCursor: (value) => cursor.set(value),
    requestLease: (blocks) => grantLease(blocks),
    close() {
      if (closed) return;
      closed = true;
      incoming.close();
      remoteCursors.close();
      leases.close();
      cursor.close();
      options.onClose?.();
    },
  };

  return {
    channel,
    get closed() {
      return closed;
    },
    deliver: (event) => (closed ? Promise.resolve() : incoming.send(event)),
    remoteCursors,
    leases,
    cursor,
  };
}
