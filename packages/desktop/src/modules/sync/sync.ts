/**
 * Sync — `core.workspace(ws).sync`: a workspace kept in step with its
 * checked-out branch on the branch's remote (MET-266).
 *
 * Sync is a property of the project: `metrists.json`'s `sync.enabled`,
 * committed, so everyone who clones a synced project is asked to sync it
 * too. Each device answers for itself in `.notefig/sync.json` (never
 * committed): `on`, or not (a local copy). Turning it off for everyone
 * commits `enabled: false`; every device stops when that reaches it.
 *
 * A workspace whose project doesn't sync costs two small file reads at
 * open: no git, no worker, no engine. The engine (`sync-engine.ts`) loads
 * when sync starts, and its git work runs in `core.gitWorker`.
 */
import { defineModule, type Hooks } from "@notefig/core";
import { GitError, type GitService } from "@notefig/git";
import type { FileSystemSurface } from "@/adapters/platform-adapter.interface";
import { platformModule } from "@/core/services";
import { documentsModule, type DocumentsApi } from "@/modules/documents";
import { editorsModule, type EditorsApi } from "@/modules/editors";
import { filesModule, type WorkspaceFiles } from "@/modules/files";
import { gitWorkerModule, type GitWorker } from "@/modules/git-worker";
import { projectSettingsModule, type ProjectSettingsApi } from "@/modules/project-settings";
import { APP_DIR_NAME } from "@/utils/app-dir";
import { setExcludeBlock } from "@/utils/git-exclude";
import { path as pathutil } from "@/utils/path";
import {
  INITIAL_SYNC_STATE,
  sameRemote,
  transition,
  type SyncEvent,
  type SyncRemote,
  type SyncState,
} from "./sync-machine";
import type { SyncEngine } from "./sync-engine";

declare module "@notefig/agent" {
  interface ToolServices {
    /** The workspace's sync (`core.workspace(ws).sync`), as a gate on writes. */
    sync?: Pick<WorkspaceSync, "checkWrite" | "state">;
  }
}

declare module "@notefig/core" {
  interface CoreHookMap {
    /** Remote changes reached the worktree (absolute `paths`). */
    "sync:remote-applied": { workspacePath: string; commit: string; paths: string[] };
  }
  interface WorkspaceModules {
    sync: WorkspaceSync;
  }
}

/** One workspace's sync, as the rest of the app sees it. */
export interface WorkspaceSync {
  readonly workspacePath: string;
  /** The current snapshot; replaced on every change. */
  state(): SyncState;
  /** Called after every change; returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
  /** Read the repo's remote and branch into `state().remote` (or say why
   *  sync can't run here), for a project that doesn't sync yet. */
  inspect(): Promise<void>;
  /** Check push access, then sync this device — and the project, for
   *  everyone, if it didn't sync yet. Rejects with what to fix. */
  turnOn(): Promise<void>;
  /** Not on this device: a local copy. */
  decline(): Promise<void>;
  /** Commit `sync.enabled: false` and push it; every device stops. */
  turnOffForEveryone(): Promise<void>;
  /** Carry on from a stop (new credential, or go after the offline-return
   *  question). */
  resume(): void;
  /** Why an agent's write of `next` to `path` is refused, naming who
   *  holds the units; null when it may go on. */
  checkWrite(path: string, next: string): Promise<string | null>;
  /** Clear the flags on text a merge overwrote. */
  dismissOverwritten(): void;
  syncNow(): Promise<void>;
  /** Resolves once the open-time read is done and the engine started. */
  whenReady(): Promise<void>;
  dispose(): Promise<void>;
}

export interface WorkspaceSyncDeps {
  workspacePath: string;
  fs: Pick<
    FileSystemSurface,
    "readFiles" | "writeFiles" | "deleteFiles" | "exists" | "readDirectory" | "getMetadata" | "writeBinaryFiles"
  >;
  hooks: Hooks;
  gitWorker: GitWorker;
  /** The platform can sync (desktop). */
  supported: boolean;
  documents: Pick<DocumentsApi, "write" | "hasUnsavedEdits">;
  editors: Pick<EditorsApi, "markdownEditor" | "paths">;
  files: Pick<WorkspaceFiles, "recordDiskChanges">;
  projectSettings: Pick<ProjectSettingsApi, "read" | "update">;
  /** Test seam: the engine's timers and window blur. */
  engine?: { setTimer?: (run: () => void, ms: number) => () => void; onBlur?: (l: () => void) => () => void };
}

/** `.notefig/sync.json`: this device's answer. */
interface SyncDevice {
  deviceId: string;
  on: boolean;
  lastSyncedAt?: number;
}

/** Kept out of every synced project, on top of its `.gitignore`: agent
 *  and editor folders, and OS litter. */
export const BUILT_IN_EXCLUDES = [
  ".claude/",
  ".codex/",
  ".gemini/",
  ".cursor/",
  ".windsurf/",
  ".continue/",
  ".aider*",
  ".vscode/",
  ".idea/",
  ".DS_Store",
];

const FALLBACK_AUTHOR = { name: "Notefig", email: "notefig@users.noreply.notefig.com" };

/** A sentence for an access check that failed. */
function accessMessage(error: unknown, remote: SyncRemote): string {
  const where = remote.url.replace(/^https:\/\//, "").replace(/\.git$/, "");
  const code = error instanceof GitError ? error.code : null;
  if (code === "AuthRequired") return `No credentials can push to ${where}. Paste a token with write access.`;
  if (code === "AuthFailed") return `These credentials can't push to ${where}. Use a token with write access to its contents.`;
  if (code === "RepoNotFound") return `${where} wasn't found, or these credentials can't see it.`;
  if (code === "Network") return `Couldn't reach ${new URL(remote.url).host}. Check the connection and try again.`;
  return error instanceof Error ? error.message : String(error);
}

export function createWorkspaceSync(deps: WorkspaceSyncDeps): WorkspaceSync {
  const root = pathutil.normalize(deps.workspacePath);
  const gitDir = pathutil.join(root, ".git");
  const devicePath = pathutil.join(root, APP_DIR_NAME, "sync.json");
  const listeners = new Set<() => void>();
  let state = INITIAL_SYNC_STATE;
  let device: SyncDevice | null = null;
  let git: GitService | null = null;
  let engine: SyncEngine | null = null;
  /** The start or stop in flight; the next waits for it. */
  let chain: Promise<void> = Promise.resolve();
  /** Sync was just turned on here: the first commit takes everything. */
  let fullScan = false;
  let disposed = false;

  const dispatch = (event: SyncEvent) => {
    const next = transition(state, event);
    if (next === state) return;
    state = next;
    for (const listener of [...listeners]) listener();
  };
  const serial = (step: () => Promise<void>) => (chain = chain.then(step, step));
  const service = () => (git ??= deps.gitWorker.create({ repoPath: root, gitDir }));

  const readDevice = async (): Promise<SyncDevice | null> => {
    const [file] = (await deps.fs.readFiles([devicePath])).succeeded;
    try {
      const parsed = file ? (JSON.parse(file.content) as Partial<SyncDevice>) : null;
      return typeof parsed?.deviceId === "string" ? { on: parsed.on === true, ...parsed, deviceId: parsed.deviceId } : null;
    } catch {
      return null;
    }
  };
  const writeDevice = async (next: SyncDevice | null) => {
    device = next;
    if (!next) await deps.fs.deleteFiles([devicePath]);
    else await deps.fs.writeFiles([{ path: devicePath, content: `${JSON.stringify(next, null, 2)}\n` }]);
  };

  /** The checked-out branch and its HTTPS remote, or why there is none. */
  const readRemote = async (): Promise<SyncRemote | string> => {
    try {
      const git = service();
      const branch = await git.currentBranch();
      if (!branch) return "Check out a branch: sync follows the checked-out branch.";
      const name = (await git.getConfig(`branch.${branch}.remote`)) ?? "origin";
      const url = await git.getConfig(`remote.${name}.url`);
      if (!url) return `This repository has no remote to sync ${branch} with.`;
      if (!/^https:\/\/[^/@\s]+\/\S+/.test(url)) return "Sync works with HTTPS remotes for now (SSH is coming).";
      return { url, branch };
    } catch {
      return "Couldn't read this repository.";
    }
  };

  const startEngine = async (remote: SyncRemote) => {
    if (engine || disposed || !device) return;
    const git = service();
    const [{ createSyncEngine }, name, email] = await Promise.all([
      import("./sync-engine"),
      git.getConfig("user.name"),
      git.getConfig("user.email"),
    ]);
    if (disposed || state.setup !== "on") return;
    const started = createSyncEngine({
      root,
      git,
      remote: { url: remote.url },
      branch: remote.branch,
      author: name && email ? { name, email } : FALLBACK_AUTHOR,
      deviceId: device.deviceId,
      lastSyncedAt: device.lastSyncedAt ?? null,
      fullScan,
      hooks: deps.hooks,
      documents: deps.documents,
      editors: deps.editors,
      files: deps.files,
      fs: deps.fs,
      state: () => state,
      dispatch,
      recordSynced: async (at) => {
        if (device?.on) await writeDevice({ ...device, lastSyncedAt: at });
      },
      ...deps.engine,
    });
    engine = started;
    fullScan = false;
    started.start();
  };

  const stopEngine = async () => {
    const running = engine;
    engine = null;
    await running?.stop();
  };

  /** For a project that syncs: this device's setup. */
  const answer = (remote: SyncRemote | string): Extract<SyncEvent, { type: "setup" }> => {
    if (typeof remote === "string") return { type: "setup", setup: "unavailable", remote: null, reason: remote };
    return { type: "setup", setup: !device ? "ask" : device.on ? "on" : "declined", remote };
  };

  /** Turned off for everyone: a later turn-on asks this device again. */
  const turnedOff = async () => {
    await stopEngine();
    if (device) await writeDevice(null);
    dispatch({ type: "setup", setup: "off", remote: state.remote });
  };

  const apply = async (next: Extract<SyncEvent, { type: "setup" }>, excludes: string[]) => {
    if (next.setup !== "on" || !sameRemote(next.remote, state.remote)) await stopEngine();
    dispatch(next);
    if (next.setup !== "on" || !next.remote) return;
    // `.notefig/` and the project's excludes stay out of every commit.
    await setExcludeBlock(deps.fs, gitDir, "notefig sync", [`${APP_DIR_NAME}/`, ...BUILT_IN_EXCLUDES, ...excludes]);
    await startEngine(next.remote);
  };

  /** Read the project's and this device's answers, and act on them. */
  const evaluate = () =>
    serial(async () => {
      if (disposed) return;
      const settings = await deps.projectSettings.read(root);
      device ??= await readDevice();
      if (settings.sync?.enabled !== true) return turnedOff();
      await apply(answer(await readRemote()), settings.sync.exclude ?? []);
    }).catch((error: unknown) => {
      console.error(`[sync] ${root}:`, error);
      dispatch({ type: "failed", fault: "offline", detail: error instanceof Error ? error.message : String(error) });
    });

  const offSettings = deps.hooks.on("project-settings:changed", ({ workspacePath }) => {
    if (pathutil.normalize(workspacePath) === root && state.setup !== "unavailable") void evaluate();
  });

  // Open: a project that doesn't sync, or a folder that isn't a repo,
  // stops at two cheap reads.
  const ready = (async () => {
    if (!deps.supported) {
      dispatch({ type: "setup", setup: "unavailable", remote: null });
      return;
    }
    const [repo] = await deps.fs.exists([gitDir]);
    if (!repo?.exists) {
      dispatch({ type: "setup", setup: "unavailable", remote: null });
      return;
    }
    await evaluate();
  })();

  return {
    workspacePath: root,
    state: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    async inspect() {
      await ready;
      if (state.setup !== "off") return;
      const remote = await readRemote();
      if (typeof remote === "string") dispatch({ type: "setup", setup: "unavailable", remote: null, reason: remote });
      else dispatch({ type: "setup", setup: "off", remote });
    },
    async turnOn() {
      await ready;
      const remote = await readRemote();
      if (typeof remote === "string") throw new Error(remote);
      try {
        // The push advertisement answers only to someone who may push.
        await service().listRemoteRefs({ url: remote.url }, [`refs/heads/${remote.branch}`], { forPush: true });
      } catch (error) {
        throw new Error(accessMessage(error, remote));
      }
      await serial(async () => {
        fullScan = true;
        await writeDevice({ ...device, deviceId: device?.deviceId ?? globalThis.crypto.randomUUID(), on: true });
      });
      const settings = await deps.projectSettings.read(root);
      // For everyone, if the project didn't sync yet: the first commit
      // carries it.
      if (settings.sync?.enabled !== true) await deps.projectSettings.update(root, { sync: { enabled: true } });
      await evaluate();
    },
    async decline() {
      await serial(() => writeDevice({ deviceId: device?.deviceId ?? globalThis.crypto.randomUUID(), on: false }));
      await evaluate();
    },
    async turnOffForEveryone() {
      // The save reaches the engine, which commits and pushes it as it
      // stops (`project-settings:changed` evaluates).
      await deps.projectSettings.update(root, { sync: { enabled: false } });
      await chain;
    },
    resume() {
      if (engine) void engine.resume();
      else {
        dispatch({ type: "resume" });
        void evaluate();
      }
    },
    dismissOverwritten: () => dispatch({ type: "dismiss-overwritten" }),
    checkWrite: async (path, next) => (engine ? engine.checkWrite(pathutil.normalize(path), next) : null),
    syncNow: async () => {
      await chain;
      await engine?.syncNow();
    },
    async whenReady() {
      await ready;
      await chain;
    },
    async dispose() {
      disposed = true;
      offSettings();
      await ready.catch(() => {});
      await chain;
      await stopEngine();
      if (git) deps.gitWorker.dispose(gitDir);
      listeners.clear();
    },
  };
}

export const syncModule = defineModule({
  name: "sync",
  needs: [platformModule, documentsModule, editorsModule, projectSettingsModule, gitWorkerModule],
  workspace: {
    needs: [filesModule],
    create: (ctx) =>
      createWorkspaceSync({
        workspacePath: ctx.workspace.path,
        fs: ctx.use("platform").fs,
        hooks: ctx.hooks,
        gitWorker: ctx.use("gitWorker"),
        supported: ctx.use("platform").gitHttp.supported,
        documents: ctx.use("documents"),
        editors: ctx.use("editors"),
        files: ctx.useWorkspace("files"),
        projectSettings: ctx.use("projectSettings"),
      }),
    dispose: (sync) => sync.dispose(),
  },
});
