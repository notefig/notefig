/**
 * In-memory platform fs adapter with jittered async latency, shared by the
 * editor sync suites (typing-pacing, typing-save-integrity,
 * external-revert-adoption). Latencies are roughly shaped like a real
 * adapter (IndexedDB / OPFS / worker RPC): writes slower than reads, and
 * *jittered* — variable completion times are what allow independent async
 * operations to finish out of order, which is the raw material of every
 * race in the typing → save → collection → adoption pipeline. Deterministic
 * PRNG (reseedable per run) so failures are reproducible.
 *
 * Use via a dynamic import inside the `vi.mock` factory (same pattern as
 * `@/testing/node-db`), then import `fake` normally in the test body:
 *
 *   vi.mock("@/adapters", async () => ({
 *     platformAdapter: {
 *       fs: (await import("@/testing/fake-fs-adapter")).fake.adapter,
 *       ...
 *     },
 *   }));
 *
 * `installWatcherSim` layers desktop (Tauri) watcher semantics on top,
 * mirrored from src-tauri: register-hash-before-write (fs_ops.rs
 * write_files), read-at-handling-time, consume-one-or-emit-external, two
 * events per atomic write (file_watcher.rs).
 */
import type { ContentChangeEvent } from "@/adapters/platform-adapter.interface";
import { calculateContentHash } from "@/utils/hash";

export interface FakeFile {
  content: string;
  modifiedAt: Date;
  createdAt: Date;
}

export interface FakeFsHooks {
  beforeWrite?: (path: string, newContent: string) => void;
  afterWrite?: (path: string) => void;
}

export function createFakeFsAdapter() {
  const store = new Map<string, FakeFile>();
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  let seed = 42;
  const reseed = (n: number) => {
    seed = n;
  };
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const writeLatency = () => 2 + Math.floor(rand() * 20);
  const readLatency = () => 1 + Math.floor(rand() * 10);

  const listeners = new Set<(event: unknown) => void>();

  // Assigned after imports (the vi.mock factory runs before them): lets a
  // suite model the desktop watcher around writeFiles.
  const hooks: FakeFsHooks = {};

  const adapter = {
    async readDirectory(path: string) {
      await sleep(readLatency());
      const prefix = path.endsWith("/") ? path : path + "/";
      return {
        ok: true as const,
        value: [...store.keys()]
          .filter((p) => p.startsWith(prefix))
          .map((p) => ({ path: p, type: "file" as const })),
      };
    },

    async getMetadata(paths: string[]) {
      await sleep(readLatency());
      const succeeded = paths
        .filter((p) => store.has(p))
        .map((p) => {
          const f = store.get(p)!;
          return {
            path: p,
            type: "file" as const,
            size: f.content.length,
            modifiedAt: f.modifiedAt,
            createdAt: f.createdAt,
          };
        });
      return { succeeded, failed: [] };
    },

    async readFiles(paths: string[]) {
      await sleep(readLatency());
      const succeeded = paths
        .filter((p) => store.has(p))
        .map((p) => ({ path: p, content: store.get(p)!.content }));
      return { succeeded, failed: [] };
    },

    async writeFiles(files: { path: string; content: string }[]) {
      for (const f of files) {
        hooks.beforeWrite?.(f.path, f.content);
      }
      await sleep(writeLatency());
      for (const f of files) {
        const existing = store.get(f.path);
        store.set(f.path, {
          content: f.content,
          modifiedAt: new Date(),
          createdAt: existing?.createdAt ?? new Date(),
        });
      }
      for (const f of files) {
        hooks.afterWrite?.(f.path);
      }
      return { succeeded: files.map((f) => f.path), failed: [] };
    },

    async createFiles(paths: string[]) {
      return adapter.writeFiles(paths.map((path) => ({ path, content: "" })));
    },

    async createDirectories(paths: string[]) {
      return { succeeded: paths, failed: [] };
    },

    async deleteFiles(paths: string[]) {
      await sleep(writeLatency());
      paths.forEach((p) => store.delete(p));
      return { succeeded: paths, failed: [] };
    },

    async deleteDirectories(paths: string[]) {
      return { succeeded: paths, failed: [] };
    },

    async moveFile() {
      return { ok: true as const, value: undefined };
    },

    async moveDirectory() {
      return { ok: true as const, value: undefined };
    },

    onFsEvent(cb: (event: unknown) => void) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },

    async startWatchingMetadata() {},
    async startWatchingContent() {},
    stopWatching() {},

    async pickDirectory() {
      return null;
    },
    async promptText() {
      return null;
    },
  };

  return { store, adapter, listeners, hooks, reseed };
}

export type FakeFsAdapter = ReturnType<typeof createFakeFsAdapter>;

/** The per-test-file instance (vitest isolates the module registry per
 * file, so suites never share state through this). */
export const fake = createFakeFsAdapter();

/**
 * Desktop watcher semantics over the fake adapter: app writes register
 * their content hash before writing; each fs event, when handled, re-reads
 * the store, consumes one matching registration, and otherwise delivers an
 * external content-change event to `onExternalChange`. Two events fire per
 * write, like the Tauri watcher's atomic temp+rename.
 */
export function installWatcherSim(options: {
  fakeFs: FakeFsAdapter;
  seed: number;
  pendingEvents: Promise<void>[];
  onExternalChange: (event: ContentChangeEvent) => Promise<void>;
}) {
  const { fakeFs, pendingEvents, onExternalChange } = options;
  const appWrites: { path: string; hash: string }[] = [];
  let eventSeed = options.seed ^ 0x5bd1e995;
  const eventDelay = () => {
    eventSeed = (eventSeed * 1103515245 + 12345) & 0x7fffffff;
    return 5 + (eventSeed % 60);
  };

  fakeFs.hooks.beforeWrite = (path, newContent) => {
    appWrites.push({ path, hash: calculateContentHash(newContent) });
  };
  const scheduleFsEvent = (path: string) => {
    pendingEvents.push(
      (async () => {
        await new Promise((r) => setTimeout(r, eventDelay()));
        const content = fakeFs.store.get(path)?.content ?? "";
        const hash = calculateContentHash(content);
        const index = appWrites.findIndex(
          (w) => w.path === path && w.hash === hash,
        );
        if (index !== -1) {
          appWrites.splice(index, 1);
          return;
        }
        await new Promise((r) => setTimeout(r, eventDelay()));
        await onExternalChange({
          changes: [{ path, content, contentHash: hash }],
        });
      })(),
    );
  };
  fakeFs.hooks.afterWrite = (path) => {
    scheduleFsEvent(path);
    scheduleFsEvent(path);
  };

  return { appWrites, scheduleFsEvent };
}
