/**
 * The sync worker's merge steps beyond a pull's rebase: recovery refs,
 * one file's uncommitted local edits merged onto the branch, a plain text
 * merge, and the failsafe's reset to the remote. Runs in the sync worker
 * (`sync-worker-api.ts` serves these).
 *
 * Recovery refs (`refs/notefig-local/recovery/<ms>`) are local only: the
 * worker pushes nothing but the branch, by name, so they never leave the
 * device (decision 10). A ref points at a commit (the local branch the
 * failsafe set aside, or the local commits a merge overwrote parts of) or
 * at a blob (a JSON record of an editor's text a merge overwrote parts
 * of, or the bytes of a file the remote won).
 */
import type { GitService } from "@notefig/git";
import type { MarkdownMerge } from "../merge/merge";
import type {
  SyncOverwrite,
  SyncReconcileOutcome,
  SyncTextMergeOutcome,
  SyncWrite,
} from "../sync-types";
import {
  failsafeReasonOf,
  isMarkdownPath,
  mergeMarkdown,
  type SyncMergePolicy,
} from "./sync-merge-driver";
import { toSyncWrite } from "./worktree-capture";

export const RECOVERY_PREFIX = "refs/notefig-local/recovery/";

/** A new recovery ref at `oid`, named by the time (and a counter). */
export async function writeRecoveryRef(
  service: GitService,
  oid: string,
  now = Date.now(),
): Promise<string> {
  for (let n = 0; ; n++) {
    const ref = `${RECOVERY_PREFIX}${now}${n > 0 ? `-${n}` : ""}`;
    if (await service.readRef(ref)) continue;
    await service.writeRef({ ref, oid, force: false });
    return ref;
  }
}

async function recoveryBlob(service: GitService, bytes: Uint8Array): Promise<string> {
  return writeRecoveryRef(service, await service.writeBlob(bytes));
}

const encode = (text: string) => new TextEncoder().encode(text);

/** What a merge step reads and decides with. */
export interface MergeContext {
  service: GitService;
  loadMerge: () => Promise<MarkdownMerge>;
  policy: SyncMergePolicy;
}

type Ours = { text: string } | { bytes: Uint8Array };

const oursWrite = (path: string, ours: Ours): SyncWrite =>
  "text" in ours ? { path, kind: "text", text: ours.text } : toSyncWrite(path, ours.bytes);

/** The remote won `path` whole: the local bytes go to a recovery ref. */
async function remoteWins(
  service: GitService,
  path: string,
  ours: Ours,
  theirs: Uint8Array,
): Promise<SyncReconcileOutcome> {
  const local = "text" in ours ? encode(ours.text) : ours.bytes;
  const recoveryRef = await recoveryBlob(service, local);
  const binary = !("text" in ours) || toSyncWrite(path, theirs).kind === "binary";
  return {
    status: "merged",
    write: toSyncWrite(path, theirs),
    overwritten: { path, fragments: "text" in ours ? [ours.text] : [], binary },
    recoveryRef,
  };
}

/**
 * `ours` holds local edits made on `previous` that aren't committed; the
 * branch moved on. Markdown: merge base (`previous`), ours and the branch
 * (which holds). Other files: the branch wins. A file the branch didn't
 * change, or deleted, keeps the local edits.
 */
export async function reconcileFile(
  ctx: MergeContext,
  branchRef: string,
  input: { path: string; previous: string; ours: Ours },
): Promise<SyncReconcileOutcome> {
  const { service, policy } = ctx;
  const { path, previous, ours } = input;
  const change = (await service.changedFiles(previous, branchRef)).find(
    (c) => c.path === path,
  );
  if (!change?.to) {
    return { status: "merged", write: oursWrite(path, ours), overwritten: null, recoveryRef: null };
  }
  const theirs = await service.readBlob(change.to);
  const theirsText = toSyncWrite(path, theirs);
  if (!("text" in ours) || !isMarkdownPath(path) || theirsText.kind !== "text") {
    return remoteWins(service, path, ours, theirs);
  }
  const base = change.from ? toSyncWrite(path, await service.readBlob(change.from)) : null;
  const merged = await mergeMarkdown(ctx.loadMerge, {
    path,
    base: base?.kind === "text" ? base.text : "",
    ours: ours.text,
    theirs: theirsText.text,
    holder: policy.holderFor(path) ?? "theirs",
    guardDivergence: false,
  });
  if ("failed" in merged) {
    return { status: "failed", reason: reasonOf(merged.failed), detail: merged.failed };
  }
  const content = merged.content ?? "";
  const fragments = merged.overwritten;
  const overwritten: SyncOverwrite | null = fragments.length > 0 ? { path, fragments } : null;
  const recoveryRef = overwritten
    ? await recoveryBlob(
        service,
        encode(JSON.stringify({ kind: "overwritten", path, base: previous, local: ours.text, fragments })),
      )
    : null;
  return { status: "merged", write: { path, kind: "text", text: content }, overwritten, recoveryRef };
}

function reasonOf(message: string) {
  const reason = failsafeReasonOf(message);
  return reason === "solo" ? "validation" : reason;
}

/** base, ours and theirs merged (theirs holds). */
export async function mergeTexts(
  ctx: MergeContext,
  input: { path: string; base: string; ours: string; theirs: string },
): Promise<SyncTextMergeOutcome> {
  const merged = await mergeMarkdown(ctx.loadMerge, {
    ...input,
    holder: ctx.policy.holderFor(input.path) ?? "theirs",
    guardDivergence: false,
  });
  if ("failed" in merged) {
    return { status: "failed", reason: reasonOf(merged.failed), detail: merged.failed };
  }
  return { status: "merged", content: merged.content ?? "", overwritten: merged.overwritten };
}

/**
 * Move the branch and the index to `remote` (already fetched) and return
 * the writes that bring the worktree there. The caller committed and set
 * aside the local state first.
 */
export async function resetBranch(
  service: GitService,
  branchRef: string,
  remote: string,
): Promise<{ head: string; writes: SyncWrite[] }> {
  const head = await service.readRef(branchRef);
  const changes = head ? await service.changedFiles(head, remote) : [];
  await service.writeRef({ ref: branchRef, oid: remote, force: true });
  const writes: SyncWrite[] = [];
  for (const change of changes) {
    await service.unstage({ filepath: change.path, ref: remote });
    writes.push(
      change.to
        ? toSyncWrite(change.path, await service.readBlob(change.to))
        : { path: change.path, kind: "delete" },
    );
  }
  return { head: remote, writes };
}
