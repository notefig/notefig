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
 *
 * Shared level: `setPeersPresent` is how presence (MET-272) moves the
 * machine between solo and shared; tests call it to force shared. What a
 * merge overwrote is kept in `overwrites()` (and announced as
 * `"sync:overwritten"`) until dismissed; the failsafe is announced as
 * `"sync:failsafe"` and resolved with `acceptIncoming` or `disable`.
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
  readRepoInfo,
  readSyncConfig,
  sessionSpecOf,
  writeSyncConfig,
  type SyncConfig,
} from "./sync-config";
import {
  INITIAL_SYNC_STATE,
  syncCapabilities,
  transition,
  type SyncCapabilities,
  type SyncEvent,
  type SyncFailsafe,
  type SyncMachineState,
} from "./sync-machine";
import {
  createDocumentPort,
  type SyncDocumentChannel,
  type SyncDocumentPort,
  type SyncIncomingContent,
} from "./document-channel";
import { syncRuntimeModule, type SyncRuntime } from "./sync-runtime";
import { editorsModule, type EditorsApi } from "@/modules/editors";
import { agentStoreModule } from "@/modules/agents/agent-collections";
import type { AgentTaskRow } from "@notefig/shared/agent";
import { resolvePresenceIdentity, type SyncPresenceSettings } from "./presence-identity";
import type {
  SyncEnableInput,
  SyncEngine,
  SyncEngineFactory,
  SyncOverwriteRecord,
  SyncPeer,
  SyncWorkerConnection,
  SyncResult,
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
    /** A merge overwrote text (the loser's side of an overlap), kept on a
     *  local-only recovery ref. */
    "sync:overwritten": { workspacePath: string; record: SyncOverwriteRecord };
    /** The failsafe stopped sync; the local state is on `recoveryRef`. */
    "sync:failsafe": SyncFailsafe & { workspacePath: string; detail: string };
    /** The other devices present changed (MET-272): who, where, and
     *  their agents. Empty when the last one left. */
    "sync:presence": { workspacePath: string; peers: readonly SyncPeer[] };
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
  /**
   * Another device's live presence appeared (true) or went away: the
   * machine's solo ↔ shared input. Presence (MET-272) calls it; tests use
   * it to force the shared level.
   */
  setPeersPresent(present: boolean): void;
  /** The failsafe's "Accept all incoming": the local state is set aside
   *  on a recovery ref, then the files become the remote's. */
  acceptIncoming(): Promise<void>;
  /** The other devices present (live presence, MET-272), with where they
   *  are and their agents. Empty in a regular workspace or alone. */
  presence(): readonly SyncPeer[];
  /** The name and colour this device shows the others: the settings, with
   *  the defaults filled in (null: not a sync workspace). */
  identity(): { name: string; color: string; settings: SyncPresenceSettings } | null;
  /** Change the name or colour (sync.json's `presence`; empty values go
   *  back to the defaults). Published with the next presence update. */
  setIdentity(settings: SyncPresenceSettings): Promise<void>;
  /** What merges overwrote, newest last, until dismissed. */
  overwrites(): readonly SyncOverwriteRecord[];
  dismissOverwrite(id: string): void;
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
    "readFiles" | "readBinaryFiles" | "writeFiles" | "deleteFiles" | "writeBinaryFiles"
  > &
    AppDirExcludeFs;
  runtime: SyncRuntime;
  hooks: Hooks;
  documents: Pick<DocumentsApi, "write" | "editorText">;
  files: Pick<WorkspaceFiles, "recordDiskChanges">;
  /** The live editors, for presence's editor plugin (shared level). */
  editors?: Pick<EditorsApi, "markdownEditor" | "paths">;
  /** This device's agent sessions (`core.agentStore.tasks`), published in
   *  presence. */
  agentTasks?: () => readonly AgentTaskRow[];
  /** Default: `Date.now`. */
  now?: () => number;
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
  let overwrites: SyncOverwriteRecord[] = [];
  let overwriteCount = 0;
  let peers: readonly SyncPeer[] = [];
  /** sync.json's `presence`, kept apart from `config` (whose identity marks
   *  which start is current) so Settings can change it while sync runs. */
  let presenceSettings: SyncPresenceSettings | undefined;
  /** The repo's `user.name`: the default presence name after sync.json's
   *  author. */
  let repoUserName: string | null = null;
  const now = deps.now ?? Date.now;

  const notify = () => {
    for (const listener of [...listeners]) listener();
  };

  const dispatch = (event: SyncEvent) => {
    const next = transition(state, event);
    if (next === state) return;
    const levelMoved = next.level !== state.level;
    state = next;
    capabilities = syncCapabilities(state);
    deps.hooks.emit("sync:state", { workspacePath, capabilities });
    if (levelMoved) engine?.levelChanged();
    notify();
  };

  const overwritten = (record: Omit<SyncOverwriteRecord, "id" | "at">) => {
    overwriteCount += 1;
    const full = { ...record, id: `overwrite-${overwriteCount}`, at: now() };
    overwrites = [...overwrites, full];
    deps.hooks.emit("sync:overwritten", { workspacePath, record: full });
    notify();
  };

  const presenceChanged = (next: readonly SyncPeer[]) => {
    peers = next;
    deps.hooks.emit("sync:presence", { workspacePath, peers });
    notify();
  };

  const openPort = (path: string): SyncDocumentPort => {
    const open = ports.get(path);
    if (open && !open.closed) return open;
    const port = createDocumentPort(path, {
      onClose: () => {
        if (ports.get(path) === port) ports.delete(path);
      },
    });
    ports.set(path, port);
    return port;
  };

  const delivered = (path: string, event: SyncIncomingContent) => {
    const port = ports.get(path);
    if (port) void port.deliver(event).catch(() => {});
  };

  /** Start the engine; the worker goes if it fails to. */
  const startEngine = async (
    factory: SyncEngineFactory,
    worker: SyncWorkerConnection,
    next: SyncConfig,
    fullScan: boolean,
  ): Promise<SyncEngine> => {
    try {
      return await factory({
        workspacePath,
        config: next,
        fullScan,
        dispatch,
        capabilities: () => capabilities,
        delivered,
        overwritten,
        presenceChanged,
        presenceSettings: () => presenceSettings,
        ports: () => [...ports.values()],
        openPort,
        worker,
        hooks: deps.hooks,
        documents: deps.documents,
        files: deps.files,
        fs: deps.fs,
        editors: deps.editors,
        agentTasks: deps.agentTasks,
      });
    } catch (error) {
      worker.terminate();
      throw error;
    }
  };

  const start = (next: SyncConfig, fullScan = false): Promise<void> => {
    config = next;
    presenceSettings = next.presence;
    void readRepoInfo(deps.fs, workspacePath)
      .then((repo) => {
        repoUserName = repo?.author?.name ?? null;
        notify();
      })
      .catch(() => {});
    dispatch({ type: "enable" });
    const run = (async () => {
      // `.notefig/` (sync.json among it) stays out of the user's repo.
      await excludeAppDir(deps.fs, workspacePath);
      const factory = await deps.runtime.loadEngine();
      if (disposed || config !== next) return;
      const worker = await deps.runtime.launchWorker();
      if (disposed || config !== next) {
        worker.terminate();
        return;
      }
      engine = await startEngine(factory, worker, next, fullScan);
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

  const retryStart = (retry: SyncConfig) => {
    void (starting ?? Promise.resolve()).then(() => {
      if (!engine && !disposed && config === retry) void start(retry);
    });
  };

  const stop = async () => {
    await starting;
    const running = engine;
    engine = null;
    starting = null;
    await running?.stop();
    if (peers.length > 0) presenceChanged([]);
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
    document: (path) => openPort(path).channel,
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
        ...(presenceSettings ? { presence: presenceSettings } : {}),
      };
      await writeSyncConfig(deps.fs, workspacePath, next);
      dispatch({ type: "disable" });
      await start(next, true);
    },
    async disable() {
      config = null;
      await stop();
      await deleteSyncConfig(deps.fs, workspacePath);
      dispatch({ type: "disable" });
    },
    resume() {
      dispatch({ type: "resume" });
      if (engine) void engine.resume();
      // A start that failed (the chunk or the worker didn't load) retries.
      else if (config && !disposed) retryStart(config);
    },
    setPeersPresent(present) {
      dispatch({ type: "peers", present });
    },
    async acceptIncoming() {
      await starting;
      await engine?.acceptIncoming();
    },
    presence: () => peers,
    identity() {
      if (!config) return null;
      const settings = presenceSettings ?? {};
      return {
        ...resolvePresenceIdentity({
          deviceId: config.deviceId,
          settings,
          authorName: config.author?.name ?? repoUserName,
        }),
        settings,
      };
    },
    async setIdentity(settings) {
      if (!config) return;
      const presence: SyncPresenceSettings = {
        ...(settings.name?.trim() ? { name: settings.name.trim() } : {}),
        ...(settings.color ? { color: settings.color } : {}),
      };
      const { presence: _old, ...rest } = config;
      const empty = Object.keys(presence).length === 0;
      await writeSyncConfig(deps.fs, workspacePath, empty ? rest : { ...rest, presence });
      // The engine reads it live (`presenceSettings`).
      presenceSettings = empty ? undefined : presence;
      notify();
    },
    overwrites: () => overwrites,
    dismissOverwrite(id) {
      const kept = overwrites.filter((record) => record.id !== id);
      if (kept.length === overwrites.length) return;
      overwrites = kept;
      notify();
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
      overwrites = [];
      peers = [];
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
  needs: [platformModule, documentsModule, syncRuntimeModule, editorsModule, agentStoreModule],
  workspace: {
    needs: [filesModule],
    create: (ctx) => {
      const tasks = ctx.use("agentStore").tasks;
      return createWorkspaceSync({
        workspacePath: ctx.workspace.path,
        fs: ctx.use("platform").fs,
        runtime: ctx.use("syncRuntime"),
        hooks: ctx.hooks,
        documents: ctx.use("documents"),
        files: ctx.useWorkspace("files"),
        editors: ctx.use("editors"),
        agentTasks: () => tasks.toArray,
      });
    },
    dispose: (sync) => sync.dispose(),
  },
});
