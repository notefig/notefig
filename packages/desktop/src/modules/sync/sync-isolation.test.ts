/**
 * A regular workspace never loads the sync engine nor starts the sync
 * worker (MET-266: "off" is inert and its code isn't loaded).
 *
 * Two halves:
 * - statically, nothing reachable from the app's root through static
 *   imports (or `new URL(…, import.meta.url)` asset references) is engine
 *   code or the sync worker: the bundler can only put them in a lazy chunk;
 * - at runtime, opening a workspace without `.notefig/sync.json` never asks
 *   `core.syncRuntime` for the engine or a worker.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { defineModule } from "@notefig/core";
import { createTestCore } from "@/testing/test-core";
import { filesModuleOf, testWorkspaceFiles } from "@/testing/test-files";
import { syncModule, syncConfigPath, type SyncRuntime } from "@/modules/sync";

const SRC = resolve(__dirname, "../..");
const ENGINE_DIR = join(SRC, "modules/sync/engine");
const MERGE_DIR = join(SRC, "modules/sync/merge");
const SYNC_WORKER = join(SRC, "workers/sync.worker.ts");

const STATIC_IMPORT =
  /^\s*(?:import|export)\s+(?!type\b)(?:[^;]*?\bfrom\s+)?["']([^"']+)["']/gm;
const ASSET_URL = /new\s+URL\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url/g;

function resolveSpecifier(from: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith("@/")) base = join(SRC, specifier.slice(2));
  else if (specifier.startsWith(".")) base = resolve(dirname(from), specifier);
  else return null; // a package: it cannot reach into the app's sources
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
  ];
  return (
    candidates.find((path) => existsSync(path) && statSync(path).isFile()) ??
    null
  );
}

/** Every app source file the root reaches without a dynamic `import()`. */
function staticGraph(root: string): Set<string> {
  const seen = new Set<string>();
  const queue = [root];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file) || !/\.(ts|tsx)$/.test(file)) continue;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    for (const pattern of [STATIC_IMPORT, ASSET_URL]) {
      for (const match of source.matchAll(pattern)) {
        const target = resolveSpecifier(file, match[1]);
        if (target) queue.push(target);
      }
    }
  }
  return seen;
}

describe("sync chunk isolation", () => {
  it("keeps the engine, the merge and the sync worker out of the app's static import graph", () => {
    expect(existsSync(join(ENGINE_DIR, "sync-engine.ts"))).toBe(true);
    expect(existsSync(join(MERGE_DIR, "merge.ts"))).toBe(true);
    const graph = staticGraph(join(SRC, "main.tsx"));

    // The module itself is wired in, so the check is not vacuous…
    expect(graph.has(join(SRC, "modules/sync/sync.ts"))).toBe(true);
    expect(graph.has(join(SRC, "modules/sync/sync-runtime.ts"))).toBe(true);
    // …and only dynamic imports lead past it.
    const leaked = [...graph].filter(
      (file) =>
        file.startsWith(`${ENGINE_DIR}/`) ||
        file.startsWith(`${MERGE_DIR}/`) ||
        file === SYNC_WORKER,
    );
    expect(leaked).toEqual([]);
  });

  it("keeps the markdown merge out of the sync engine's main-thread graph", () => {
    // The merge runs only in the sync worker, and only once it merges.
    const graph = staticGraph(join(ENGINE_DIR, "sync-engine.ts"));
    expect([...graph].filter((file) => file.startsWith(`${MERGE_DIR}/`))).toEqual([]);
    const worker = staticGraph(join(ENGINE_DIR, "sync-worker-api.ts"));
    expect(worker.has(join(MERGE_DIR, "merge.ts"))).toBe(false);
  });

  it("never asks for the engine or a worker in a regular workspace", async () => {
    const WS = "/regular";
    const runtime: SyncRuntime = {
      loadEngine: vi.fn(async () => {
        throw new Error("engine loaded");
      }),
      launchWorker: vi.fn(async () => {
        throw new Error("worker started");
      }),
    };
    const readFiles = vi.fn(async (paths: string[]) => ({
      succeeded: [],
      failed: paths.map((path) => ({
        path,
        type: "not_found" as const,
        message: "not found",
      })),
    }));
    const core = createTestCore({
      modules: [
        filesModuleOf([testWorkspaceFiles(WS, { readFiles } as never)]),
        defineModule({ name: "documents", register: () => ({}) as never }),
        defineModule({ name: "syncRuntime", register: () => runtime }),
        syncModule,
      ],
      platform: { fs: { readFiles, exists: async () => [] } as never },
    });
    await core.boot();
    await core.workspace(WS).open();
    const sync = core.workspace(WS).sync;
    await sync.whenReady();

    expect(readFiles).toHaveBeenCalledWith([syncConfigPath(WS)]);
    expect(sync.capabilities().active).toBe(false);
    expect(sync.capabilities().status).toBe("off");
    expect(runtime.loadEngine).not.toHaveBeenCalled();
    expect(runtime.launchWorker).not.toHaveBeenCalled();
    await core.dispose();
  });

  it("asks for both once the workspace has a sync config", async () => {
    const WS = "/synced";
    const runtime: SyncRuntime = {
      loadEngine: vi.fn(async () => async () => ({
        syncNow: async () => {},
        resume: async () => {},
        acceptIncoming: async () => {},
        levelChanged: () => {},
        gateWrite: async (_write: unknown, perform: () => Promise<void>) => perform(),
        checkLease: () => ({ granted: true as const }),
        stop: async () => {},
      })),
      launchWorker: vi.fn(async () => ({
        api: {} as never,
        terminate: vi.fn(),
      })),
    };
    const config = JSON.stringify({
      remote: "https://example.com/team/notes.git",
      branch: "main",
      deviceId: "device-1",
    });
    const readFiles = vi.fn(async (paths: string[]) => ({
      succeeded: paths
        .filter((path) => path === syncConfigPath(WS))
        .map((path) => ({ path, content: config })),
      failed: [],
    }));
    const core = createTestCore({
      modules: [
        filesModuleOf([testWorkspaceFiles(WS, { readFiles } as never)]),
        defineModule({ name: "documents", register: () => ({}) as never }),
        defineModule({ name: "syncRuntime", register: () => runtime }),
        syncModule,
      ],
      platform: { fs: { readFiles, exists: async () => [] } as never },
    });
    await core.boot();
    await core.workspace(WS).open();
    await core.workspace(WS).sync.whenReady();

    expect(runtime.loadEngine).toHaveBeenCalledTimes(1);
    expect(runtime.launchWorker).toHaveBeenCalledTimes(1);
    expect(core.workspace(WS).sync.capabilities().active).toBe(true);
    await core.dispose();
  });
});
