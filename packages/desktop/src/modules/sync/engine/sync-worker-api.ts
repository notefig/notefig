/**
 * The sync worker's side: every git step of a sync cycle, over
 * `@notefig/git`'s worker API (`createGitWorkerApi`, one service per
 * gitdir). Runs inside `workers/sync.worker.ts`; tests serve the same code
 * in-process over a fake remote.
 *
 * Every method answers with data (`SyncResult`), never throws: a `GitError`
 * becomes `{ code, message }`.
 *
 * Solo (MET-270) never writes conflict markers and never merges text: the
 * merge driver refuses every file both sides changed, so a rebase only
 * succeeds when local and remote commits touch different files, and
 * anything else comes back `diverged` with nothing moved. MET-271 replaces
 * the driver with the markdown merge.
 */
import {
  GitError,
  ZERO_OID,
  createGitWorkerApi,
  createRpcGitService,
  type GitHttpClient,
  type GitMergeDriver,
  type GitRebaseResult,
  type GitRepoRef,
  type GitService,
  type GitStorageHost,
  type GitWorkerApi,
} from "@notefig/git";
import type { GitHostFs } from "@/adapters/git-storage-host";
import { IGNORE_RULES } from "@/utils/ignore";
import { path as pathutil } from "@/utils/path";
import type { SyncAuthor } from "../sync-config";
import type {
  SyncPullOutcome,
  SyncPushOutcome,
  SyncResult,
  SyncSessionSpec,
  SyncWorkerApi,
  SyncWrite,
} from "../sync-types";
import { createWorktreeCapture, type WorktreeCapture } from "./worktree-capture";

/** Where the remote's notefig state lives (MET-266 decision 18). */
export const NOTEFIG_REFS_PREFIX = "refs/notefig/v1/";

/**
 * Solo's merge driver: no file merges (see above). Only when the user
 * resumes from `diverged` does a pull keep the local side of the files both
 * changed, whole; the remote's version stays in the branch's history.
 */
export function soloMergeDriver(policy: { keepLocal: boolean }): GitMergeDriver {
  return {
    merge: ({ path, ours, theirs }) =>
      policy.keepLocal
        ? { content: ours, overwritten: theirs === null ? [] : [theirs] }
        : { failed: `${path} changed on both sides, and solo sync never merges a file.` },
  };
}

const branchRef = (branch: string) => `refs/heads/${branch}`;
/** The last remote tip this clone fetched: keeps a diverged remote commit
 *  reachable locally. Never pushed (decision 10). */
const trackingRef = (branch: string) => `refs/notefig-local/remote/${branch}`;

async function attempt<T>(op: () => Promise<T>): Promise<SyncResult<T>> {
  try {
    return { ok: true, value: await op() };
  } catch (error) {
    const code = error instanceof GitError ? error.code : "Unknown";
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: { code, message } };
  }
}

/** `notefig: Ada edited notes.md, plan.md and 3 more`. */
export function commitMessage(userName: string, paths: string[]): string {
  const names = paths.map((path) => path.split("/").pop() ?? path);
  const shown = names.slice(0, 3);
  const rest = names.length - shown.length;
  const list =
    rest > 0
      ? `${shown.join(", ")} and ${rest} more`
      : shown.length > 1
        ? `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`
        : (shown[0] ?? "files");
  return `notefig: ${userName} edited ${list}`;
}

/** The app's own folder never syncs, whatever the repo's excludes say. */
const APP_DIR = /^\.notefig(\/|$)/;

/** What a repo's status says to commit, of the paths `keep` allows. */
function pendingChanges(
  status: Awaited<ReturnType<GitService["status"]>>,
  keep: (path: string) => boolean,
) {
  const add = new Set(status.untracked.filter(keep));
  const remove = new Set<string>();
  for (const change of status.unstaged) {
    if (keep(change.path)) {
      (change.type === "deleted" ? remove : add).add(change.path);
    }
  }
  const staged = status.staged.map((c) => c.path).filter(keep);
  const all = new Set([...add, ...remove, ...staged]);
  return { add: [...add], remove: [...remove], all: [...all].sort() };
}

/** What the start-up scan reads: one listing, metadata in batches. */
export type ScanFs = Pick<GitHostFs, "readDirectory" | "getMetadata">;

/** Files changed this long before the last commit still count. */
const SCAN_SLACK_MS = 120_000;
const METADATA_BATCH = 500;

async function inBatches<T>(items: string[], run: (batch: string[]) => Promise<T[]>) {
  const out: T[] = [];
  for (let at = 0; at < items.length; at += METADATA_BATCH) {
    out.push(...(await run(items.slice(at, at + METADATA_BATCH))));
  }
  return out;
}

/**
 * The files that may have changed while sync wasn't watching (the app was
 * closed, or offline edits): written since the last commit, or tracked and
 * gone. One listing and a metadata call per 500 files, instead of the stat
 * and hash per file a whole-tree status costs over the host channel (a
 * fresh clone's index stats never match ours, so status would re-read
 * every file). Null when there is no commit yet: status walks everything.
 */
async function scanCandidates(
  service: GitService,
  fs: ScanFs,
  root: string,
): Promise<string[] | null> {
  const [last] = await service.log({ depth: 1 }).catch(() => []);
  if (!last) return null;
  const since = last.commit.committer.timestamp * 1000 - SCAN_SLACK_MS;
  const listing = await fs.readDirectory(root, {
    recursive: true,
    includeFiles: true,
    includeDirectories: false,
    ignore: IGNORE_RULES,
  });
  if (!listing.ok) return null;
  const onDisk = listing.value.map((entry) => entry.path);
  const changed = await inBatches(onDisk, async (batch) =>
    (await fs.getMetadata(batch)).succeeded
      .filter((meta) => new Date(meta.modifiedAt).getTime() > since)
      .map((meta) => meta.path),
  );
  const tree = (path: string) => pathutil.toTreePath(pathutil.relative(root, path) ?? path);
  const listed = new Set(onDisk.map(tree));
  // Tracked but not listed: deleted, or only hidden by the listing's
  // ignore rules — the metadata call tells them apart.
  const unlisted = (await service.listFiles()).filter((path) => !listed.has(path));
  const gone = await inBatches(unlisted, async (batch) =>
    (await fs.getMetadata(batch.map((p) => pathutil.join(root, pathutil.fromTreePath(p))))).failed
      .filter((failure) => failure.type === "not_found")
      .map((failure) => failure.path),
  );
  return [...changed, ...gone].map(tree).filter((path) => !APP_DIR.test(path));
}

async function commitChanges(
  service: GitService,
  paths: string[] | null,
  author: SyncAuthor,
  userName: string,
): Promise<{ oid: string | null; paths: string[] }> {
  if (paths && paths.length === 0) return { oid: null, paths: [] };
  const status = await service.status(paths ? { filepaths: paths } : undefined);
  const changes = pendingChanges(status, (path) => !APP_DIR.test(path));
  if (changes.all.length === 0) return { oid: null, paths: [] };
  for (const filepath of changes.add) await service.add({ filepath });
  for (const filepath of changes.remove) await service.remove({ filepath });
  const oid = await service.commit({
    message: commitMessage(userName, changes.all),
    author: { name: author.name, email: author.email },
  });
  return { oid, paths: changes.all };
}

function pullOutcome(
  result: GitRebaseResult,
  writes: SyncWrite[],
): SyncPullOutcome {
  switch (result.status) {
    case "up-to-date":
      return { status: "up-to-date", head: result.oid };
    case "fast-forward":
    case "rebased":
      return {
        status: result.status,
        head: result.oid,
        writes,
        skippedDirty: result.skippedDirty,
      };
    case "conflicted":
      return {
        status: "diverged",
        paths: [...new Set(result.conflicts.map((c) => c.path))],
      };
    case "unrelated":
      return { status: "unrelated" };
  }
}

/** Push access, as git itself discovers it: the receive-pack
 *  advertisement answers 200 only to someone who may push. */
async function canPush(
  http: GitHttpClient,
  remote: SyncSessionSpec["remote"],
): Promise<boolean> {
  const response = await http.request({
    url: `${remote.url.replace(/\/+$/, "")}/info/refs?service=git-receive-pack`,
    method: "GET",
    headers: { "User-Agent": "git/notefig" },
    credential: remote.credential,
  });
  if (response.status === 200) return true;
  if (response.status === 401 || response.status === 403) return false;
  if (response.status === 404) {
    throw new GitError("RepoNotFound", "The remote repository was not found.");
  }
  if (response.status === 429) {
    throw new GitError("Throttled", "The remote is rate limiting requests.");
  }
  throw new GitError("Network", `The remote answered ${response.status}.`);
}

/** The pieces `startGitWorker` is wired with, shared by the worker entry
 *  and the in-process test runtime. */
export interface SyncWorkerWiring {
  http: GitHttpClient;
  /** For the start-up scan. */
  scanFs: ScanFs;
  capture: WorktreeCapture;
  /** Read by the merge driver during a pull. */
  policy: { keepLocal: boolean };
  wrapHost: (host: GitStorageHost, repo: GitRepoRef) => GitStorageHost;
  deps: () => { http: GitHttpClient; mergeDriver: GitMergeDriver };
}

export function syncWorkerWiring(http: GitHttpClient, scanFs: ScanFs): SyncWorkerWiring {
  const capture = createWorktreeCapture();
  const policy = { keepLocal: false };
  const mergeDriver = soloMergeDriver(policy);
  return {
    http,
    scanFs,
    capture,
    policy,
    wrapHost: (host, repo) => capture.wrap(host, repo),
    deps: () => ({ http, mergeDriver }),
  };
}

/** Build the whole worker API in-process: tests' entry point. */
export function createInProcessSyncWorker(
  createHost: (repo: GitRepoRef) => GitStorageHost,
  http: GitHttpClient,
  scanFs: ScanFs,
): SyncWorkerApi {
  const wiring = syncWorkerWiring(http, scanFs);
  const git = createGitWorkerApi(
    (repo) => wiring.wrapHost(createHost(repo), repo),
    wiring.deps,
  );
  return createSyncWorkerApi(git, wiring);
}

export function createSyncWorkerApi(
  git: GitWorkerApi,
  wiring: Pick<SyncWorkerWiring, "http" | "scanFs" | "capture" | "policy">,
): SyncWorkerApi {
  const { http, scanFs, capture, policy } = wiring;
  let session: { spec: SyncSessionSpec; repo: GitRepoRef; service: GitService } | null =
    null;

  const serviceFor = (repo: GitRepoRef) =>
    createRpcGitService((method, args) => git.gitCall(repo, method, args));

  const current = () => {
    if (!session) throw new GitError("InvalidInput", "No sync session is open.");
    return session;
  };

  const readHead = (service: GitService, branch: string) =>
    service.readRef(branchRef(branch));

  return {
    open: (spec) =>
      attempt(async () => {
        const repo = { repoPath: spec.workspacePath, gitDir: spec.gitDir };
        const service = serviceFor(repo);
        session = { spec, repo, service };
        return { head: await readHead(service, spec.branch) };
      }),

    commit: ({ paths, author, userName }) =>
      attempt(async () => {
        const { service, spec } = current();
        const scoped =
          paths === "scan"
            ? await scanCandidates(service, scanFs, spec.workspacePath)
            : paths === "all"
              ? null
              : paths;
        return commitChanges(service, scoped, author, userName);
      }),

    poll: () =>
      attempt(async () => {
        const { spec, service } = current();
        const wanted = branchRef(spec.branch);
        const refs = await service.listRemoteRefs(spec.remote, [
          wanted,
          NOTEFIG_REFS_PREFIX,
        ]);
        return {
          remote: refs.find((ref) => ref.ref === wanted)?.oid ?? null,
          notefigRefs: refs.filter((ref) => ref.ref.startsWith(NOTEFIG_REFS_PREFIX))
            .length,
        };
      }),

    pull: ({ remote, keepLocal }) =>
      attempt(async () => {
        const { spec, repo, service } = current();
        await service.fetchRefs(spec.remote, [
          { ref: branchRef(spec.branch), oid: remote, localRef: trackingRef(spec.branch) },
        ]);
        policy.keepLocal = keepLocal === true;
        try {
          const { result, writes } = await capture.run(repo, () =>
            service.rebaseOnto({ theirs: remote, holder: keepLocal ? "ours" : "theirs" }),
          );
          return pullOutcome(result, writes);
        } finally {
          policy.keepLocal = false;
        }
      }),

    push: ({ remote }) =>
      attempt(async (): Promise<SyncPushOutcome> => {
        const { spec, service } = current();
        const head = await readHead(service, spec.branch);
        if (!head) throw new GitError("InvalidInput", "The branch has no commits.");
        if (head === remote) return { status: "up-to-date", head };
        // The branch only ever moves forward (decision 10).
        if (remote && (await service.mergeBase(head, remote)) !== remote) {
          return { status: "rejected", reason: "not a fast-forward" };
        }
        try {
          const result = await service.pushRefs(
            spec.remote,
            [{ ref: branchRef(spec.branch), old: remote ?? ZERO_OID, new: head }],
            { haves: remote ? [remote] : [] },
          );
          if (result.ok) return { status: "pushed", head };
          const refused = result.refs.find((ref) => !ref.ok);
          return {
            status: "rejected",
            reason: refused && !refused.ok ? refused.reason : result.unpack,
          };
        } catch (error) {
          if (error instanceof GitError && error.code === "PushOutcomeUnknown") {
            return { status: "unknown" };
          }
          throw error;
        }
      }),

    verify: ({ spec }) =>
      attempt(async () => {
        const service = serviceFor({
          repoPath: spec.workspacePath,
          gitDir: spec.gitDir,
        });
        const wanted = branchRef(spec.branch);
        const refs = await service.listRemoteRefs(spec.remote, [wanted]);
        return {
          remoteHead: refs.find((ref) => ref.ref === wanted)?.oid ?? null,
          canPush: await canPush(http, spec.remote),
        };
      }),
  };
}
