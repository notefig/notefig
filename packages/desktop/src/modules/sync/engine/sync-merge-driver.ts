/**
 * The `GitMergeDriver` the sync worker hands `@notefig/git`: what happens
 * to a file both sides changed when a pull replays local commits onto the
 * remote's.
 *
 * - Solo (`policy.merge` false): nothing merges. Every such file refuses,
 *   so the rebase moves nothing, and the engine moves to shared first: a
 *   remote that diverged from us proves someone else is writing.
 * - Shared: markdown goes through the markdown merge (`merge/merge.ts`),
 *   loaded into the worker on first use, so a solo worker never loads the
 *   codec. Any other file: the remote wins, and the local version is kept
 *   on a recovery ref (the worker writes it; see `log`).
 * - Resume from a stop (`policy.keepLocal`): the local side wins whole.
 *
 * Holder: the rebase's (the side already on the branch, theirs), unless
 * `policy.holderFor(path)` decides per block — MET-273's leases plug in
 * there.
 *
 * A merge that fails validation, or an offline divergence over the
 * threshold (`policy.guardDivergence`), refuses with a message the worker
 * reads back as the failsafe's reason (`failsafeReasonOf`).
 */
import type { GitMergeDriver, GitMergeOutput } from "@notefig/git";
import type { BlockHolder, MarkdownMerge, MergeStats } from "../merge/merge";

/**
 * Offline divergence (decision 20): when returning edits made offline
 * collide with this share of the blocks the remote changed meanwhile, the
 * failsafe asks the user instead of merging…
 */
export const FAILSAFE_COLLISION_SHARE = 0.3;
/** …provided at least this many blocks collide, so a short note where one
 *  sentence overlapped is still an ordinary merge. */
export const FAILSAFE_MIN_COLLIDED_BLOCKS = 3;

export interface SyncMergePolicy {
  /** Shared: merge files both sides changed. Solo: refuse them. */
  merge: boolean;
  /** The user resumed from a stop: keep the local side whole. */
  keepLocal: boolean;
  /** The local commits were made offline: apply the divergence threshold. */
  guardDivergence: boolean;
  /** Who holds each block of `path`; null: the rebase's holder. */
  holderFor: (path: string) => BlockHolder | null;
}

export function defaultMergePolicy(): SyncMergePolicy {
  return { merge: false, keepLocal: false, guardDivergence: false, holderFor: () => null };
}

/** What a pull's merges did beyond `rebaseOnto`'s own report. */
export interface SyncMergeLog {
  /** Files the remote won whole (not markdown); the local copy is on the
   *  recovery ref. */
  tookRemote: { path: string; binary: boolean }[];
}

export type FailsafeReason = "unrelated" | "validation" | "divergence";

const SOLO_REFUSAL = "solo:";
const VALIDATION = "validation:";
const DIVERGENCE = "divergence:";

/** Why a refused merge refused: solo's refusal, or a failsafe reason. */
export function failsafeReasonOf(message: string | undefined): FailsafeReason | "solo" {
  if (message?.startsWith(SOLO_REFUSAL)) return "solo";
  if (message?.startsWith(DIVERGENCE)) return "divergence";
  return "validation";
}

export const isMarkdownPath = (path: string) => /\.(md|markdown)$/i.test(path);

/** Whether a merge's collisions cross the offline-divergence threshold. */
export function overDivergenceThreshold(stats: MergeStats): boolean {
  return (
    stats.collided >= FAILSAFE_MIN_COLLIDED_BLOCKS &&
    stats.collided / Math.max(1, stats.theirsChanged) > FAILSAFE_COLLISION_SHARE
  );
}

/** One markdown file, three versions in: the merged text, or a refusal. */
export async function mergeMarkdown(
  loadMerge: () => Promise<MarkdownMerge>,
  input: {
    path: string;
    base: string;
    ours: string;
    theirs: string;
    holder: "ours" | "theirs" | BlockHolder;
    guardDivergence: boolean;
  },
): Promise<GitMergeOutput> {
  const merge = await loadMerge();
  const result = merge(input);
  if ("failed" in result) return { failed: `${VALIDATION} ${input.path}: ${result.failed}` };
  if (input.guardDivergence && overDivergenceThreshold(result.stats)) {
    return {
      failed: `${DIVERGENCE} ${input.path}: ${result.stats.collided} of the ${result.stats.theirsChanged} blocks changed on the remote were also changed here`,
    };
  }
  return { content: result.content, overwritten: result.overwritten };
}

export function createSyncMergeDriver(
  policy: SyncMergePolicy,
  loadMerge: () => Promise<MarkdownMerge>,
  log: SyncMergeLog,
): GitMergeDriver {
  return {
    async merge({ path, base, ours, theirs, holder }) {
      if (policy.keepLocal) {
        return { content: ours, overwritten: theirs === null ? [] : [theirs] };
      }
      if (!policy.merge) {
        return { failed: `${SOLO_REFUSAL} ${path} changed on both sides, and solo sync never merges a file.` };
      }
      // A delete against an edit keeps the edit.
      if (ours === null) return { content: theirs, overwritten: [] };
      if (theirs === null) return { content: ours, overwritten: [] };
      if (!isMarkdownPath(path)) {
        log.tookRemote.push({ path, binary: false });
        return { content: theirs, overwritten: [ours] };
      }
      return mergeMarkdown(loadMerge, {
        path,
        base: base ?? "",
        ours,
        theirs,
        holder: policy.holderFor(path) ?? holder,
        guardDivergence: policy.guardDivergence,
      });
    },
    pickBinary({ path }) {
      if (policy.keepLocal) return "ours";
      if (!policy.merge) {
        return { failed: `${SOLO_REFUSAL} ${path} changed on both sides, and solo sync never merges a file.` };
      }
      log.tookRemote.push({ path, binary: true });
      return "theirs";
    },
  };
}
