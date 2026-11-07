/**
 * Sync — `core.workspace(ws).sync`: a workspace kept in step with one
 * branch of its git remote (MET-266).
 *
 * Every open workspace gets an instance. `create` reads
 * `<ws>/.notefig/sync.json`:
 *
 * - absent: the instance is an inert stub. Nothing is imported, no worker
 *   starts, no listener is added; its capabilities say `off`.
 * - present: it loads the engine chunk (`core.syncRuntime`) and starts the
 *   sync worker. The engine commits, polls, pulls and pushes; all git work
 *   runs in the worker, and the main thread only applies what it returns.
 *
 * State lives in one pure machine (`sync-machine.ts`); consumers read its
 * capabilities (`capabilities()`, `"sync:state"`), never raw states.
 * `dispose` stops the engine: its timers, its listeners and the worker.
 */
import { defineModule, type Hooks } from "@notefig/core";
import type { FileSystemSurface } from "@/adapters/platform-adapter.interface";
import { platformModule } from "@/core/services";
import { documentsModule, type DocumentsApi } from "@/modules/documents";
import { filesModule, type WorkspaceFiles } from "@/modules/files";
import { excludeAppDir, type AppDirExcludeFs } from "@/modules/app-dir-exclude";
import { path as pathutil } from "@/utils/path";
import {
  deleteSyncConfig,
  newDeviceId,
  readSyncConfig,
  remoteCredentialKey,
  writeSyncConfig,
  type SyncConfig,
} from "./sync-config";
import {
  INITIAL_SYNC_STATE,
  syncCapabilities,
  transition,
  type SyncCapabilities,
  type SyncEvent,
  type SyncMachineState,
} from "./sync-machine";
import {
  createDocumentPort,
  type SyncDocumentChannel,
  type SyncDocumentPort,
  type SyncIncomingContent,
} from "./document-channel";
import { syncRuntimeModule, type SyncRuntime } from "./sync-runtime";
import type {
  SyncEnableInput,
  SyncEngine,
  SyncResult,
  SyncSessionSpec,
  SyncVerifyOutcome,
} from "./sync-types";

declare module "@notefig/core" {
  interface CoreHookMap {
    /** A sync workspace's state changed (also: turned on or off). */
    "sync:state": { workspacePath: string; capabilities: SyncCapabilities };
    /** Local changes were committed. `paths` are `/`-separated. */
    "sync:committed": { workspacePath: string; commit: string; paths: string[] };
    /** The branch was pushed to the remote. */
    "sync:pushed": { workspacePath: string; commit: string };
    /** Remote changes reached the worktree (absolute `paths`). */
    "sync:remote-applied": {
      workspacePath: string;
      commit: string;
      paths: string[];
    };
  }
}

/** One workspace's sync, as the rest of the app sees it. */
export interface WorkspaceSync {
  readonly workspacePath: string;
  /** What sync does in its current state. */
  capabilities(): SyncCapabilities;
  /** Called after every state change; returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
  /** The workspace's sync config; null for a regular workspace. */
  config(): SyncConfig | null;
  /**
   * The editor ↔ sync channel for one open document (see
   * `document-channel.ts`). One per path at a time: asking again returns
   * the open one. Closing it detaches.
   */
  document(path: string): SyncDocumentChannel;
  /** Check read and push access with the stored token, before turning
   *  sync on. Starts a worker for the check if none runs. */
  verify(input: SyncEnableInput): Promise<SyncResult<SyncVerifyOutcome>>;
  /** Turn sync on: write sync.json (a fresh device id), then start: commit
   *  local changes, then push or fast-forward. */
  enable(input: SyncEnableInput): Promise<void>;
  /** Turn sync off: stop, delete sync.json. The token stays (the caller
   *  offers to delete it). */
  disable(): Promise<void>;
  /** Leave a sticky fault (new token, or keep local files and go on). */
  resume(): void;
  /** Run a cycle now. */
  syncNow(): Promise<void>;
  /** Resolves once the config was read and, for a sync workspace, the
   *  engine started (or failed to). */
  whenReady(): Promise<void>;
  /** Stop everything: the engine's timers and listeners, the worker, the
   *  open channels. The module's `dispose`. */
  dispose(): Promise<void>;
}

/** What one workspace's sync is built from. */
export interface WorkspaceSyncDeps {
  workspacePath: string;
  fs: Pick<
    FileSystemSurface,
    "readFiles" | "writeFiles" | "deleteFiles" | "writeBinaryFiles"
  > &
    AppDirExcludeFs;
  runtime: SyncRuntime;
  hooks: Hooks;
  documents: Pick<DocumentsApi, "write">;
  files: Pick<WorkspaceFiles, "recordDiskChanges">;
}

/** The session a config describes. */
export function sessionSpecOf(
  workspacePath: string,
  config: Pick<SyncConfig, "remote" | "branch">,
): SyncSessionSpec {
  const root = pathutil.normalize(workspacePath);
  return {
    workspacePath: root,
    gitDir: pathutil.join(root, ".git"),
    remote: { url: config.remote, credential: remoteCredentialKey(config.remote) },
    branch: config.branch,
  };
}

export function createWorkspaceSync(deps: WorkspaceSyncDeps): WorkspaceSync {
  const workspacePath = pathutil.normalize(deps.workspacePath);
  const listeners = new Set<() => void>();
  const ports = new Map<string, SyncDocumentPort>();
  let state: SyncMachineState = INITIAL_SYNC_STATE;
  /** Rebuilt on each change only, so readers get a stable snapshot. */
  let capabilities = syncCapabilities(state);
  let config: SyncConfig | null = null;
  let engine: SyncEngine | null = null;
  /** The engine start in flight, so stop waits for it. */
  let starting: Promise<void> | null = null;
  let disposed = false;

  const dispatch = (event: SyncEvent) => {
    const next = transition(state, event);
    if (next === state) return;
    state = next;
    capabilities = syncCapabilities(state);
    deps.hooks.emit("sync:state", { workspacePath, capabilities });
    for (const listener of [...listeners]) listener();
  };

  const delivered = (path: string, event: SyncIncomingContent) => {
    const port = ports.get(path);
    if (port) void port.deliver(event).catch(() => {});
  };

  const start = (next: SyncConfig): Promise<void> => {
    config = next;
    dispatch({ type: "enable" });
    const run = (async () => {
      const factory = await deps.runtime.loadEngine();
      if (disposed || config !== next) return;
      const worker = await deps.runtime.launchWorker();
      if (disposed || config !== next) {
        worker.terminate();
        return;
      }
      engine = await factory({
        workspacePath,
        config: next,
        dispatch,
        capabilities: () => capabilities,
        delivered,
        worker,
        hooks: deps.hooks,
        documents: deps.documents,
        files: deps.files,
        fs: deps.fs,
      });
    })().catch((error: unknown) => {
      console.error(`[sync] Could not start sync for ${workspacePath}:`, error);
      dispatch({
        type: "failed",
        fault: "offline",
        detail: error instanceof Error ? error.message : String(error),
      });
    });
    starting = run;
    return run;
  };

  const stop = async () => {
    await starting;
    const running = engine;
    engine = null;
    starting = null;
    await running?.stop();
  };

  const ready = (async () => {
    const found = await readSyncConfig(deps.fs, workspacePath);
    if (found && !disposed) await start(found);
  })();

  return {
    workspacePath,
    capabilities: () => capabilities,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    config: () => config,
    document(path) {
      const open = ports.get(path);
      if (open && !open.closed) return open.channel;
      const port = createDocumentPort(path, {
        onClose: () => {
          if (ports.get(path) === port) ports.delete(path);
        },
      });
      ports.set(path, port);
      return port.channel;
    },
    async verify(input) {
      const worker = await deps.runtime.launchWorker();
      try {
        return await worker.api.verify({
          spec: sessionSpecOf(workspacePath, input),
        });
      } finally {
        worker.terminate();
      }
    },
    async enable(input) {
      await stop();
      const next: SyncConfig = {
        remote: input.remote,
        branch: input.branch,
        deviceId: config?.deviceId ?? newDeviceId(),
        ...(input.author ? { author: input.author } : {}),
      };
      await excludeAppDir(deps.fs, workspacePath);
      await writeSyncConfig(deps.fs, workspacePath, next);
      dispatch({ type: "disable" });
      await start(next);
    },
    async disable() {
      config = null;
      await stop();
      await deleteSyncConfig(deps.fs, workspacePath);
      dispatch({ type: "disable" });
    },
    resume() {
      dispatch({ type: "resume" });
      void engine?.syncNow();
    },
    syncNow: async () => {
      await starting;
      await engine?.syncNow();
    },
    async whenReady() {
      await ready;
      await starting;
    },
    async dispose() {
      disposed = true;
      await ready.catch(() => {});
      await stop();
      for (const port of [...ports.values()]) port.channel.close();
      ports.clear();
      listeners.clear();
    },
  };
}

declare module "@notefig/core" {
  interface WorkspaceModules {
    sync: WorkspaceSync;
  }
}

export const syncModule = defineModule({
  name: "sync",
  needs: [platformModule, documentsModule, syncRuntimeModule],
  workspace: {
    needs: [filesModule],
    create: (ctx) =>
      createWorkspaceSync({
        workspacePath: ctx.workspace.path,
        fs: ctx.use("platform").fs,
        runtime: ctx.use("syncRuntime"),
        hooks: ctx.hooks,
        documents: ctx.use("documents"),
        files: ctx.useWorkspace("files"),
      }),
    dispose: (sync) => sync.dispose(),
  },
});
