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

/** Solo's driver: no file merges (see above). */
export const refuseOverlaps: GitMergeDriver = {
  merge: ({ path }) => ({
    failed: `${path} changed on both sides, and solo sync never merges a file.`,
  }),
};

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
export function syncWorkerWiring(http: GitHttpClient): {
  capture: WorktreeCapture;
  wrapHost: (host: GitStorageHost, repo: GitRepoRef) => GitStorageHost;
  deps: () => { http: GitHttpClient; mergeDriver: GitMergeDriver };
} {
  const capture = createWorktreeCapture();
  return {
    capture,
    wrapHost: (host, repo) => capture.wrap(host, repo),
    deps: () => ({ http, mergeDriver: refuseOverlaps }),
  };
}

/** Build the whole worker API in-process: tests' entry point. */
export function createInProcessSyncWorker(
  createHost: (repo: GitRepoRef) => GitStorageHost,
  http: GitHttpClient,
): SyncWorkerApi {
  const wiring = syncWorkerWiring(http);
  const git = createGitWorkerApi(
    (repo) => wiring.wrapHost(createHost(repo), repo),
    wiring.deps,
  );
  return createSyncWorkerApi(git, wiring.capture, http);
}

export function createSyncWorkerApi(
  git: GitWorkerApi,
  capture: WorktreeCapture,
  http: GitHttpClient,
): SyncWorkerApi {
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
      attempt(() => commitChanges(current().service, paths, author, userName)),

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

    pull: ({ remote }) =>
      attempt(async () => {
        const { spec, repo, service } = current();
        await service.fetchRefs(spec.remote, [
          { ref: branchRef(spec.branch), oid: remote, localRef: trackingRef(spec.branch) },
        ]);
        const { result, writes } = await capture.run(repo, () =>
          service.rebaseOnto({ theirs: remote, holder: "theirs" }),
        );
        return pullOutcome(result, writes);
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
