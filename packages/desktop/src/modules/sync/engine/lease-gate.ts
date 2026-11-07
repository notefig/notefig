/**
 * Sync's lease gate for agent writes (MET-273, decision 11), registered on
 * `core.writeGate` by the sync module and active only at the shared level.
 * The agent service knows nothing of it: it hands every ACP
 * `fs/write_text_file` to the write gate.
 *
 * 1. Before the write: the worker diffs the write's top-level blocks
 *    against the document as the agent sees it (an open editor's text
 *    included) and runs the lease rule (`lease-rules.ts`, the same
 *    function people go through) against the leases mapped onto it. A
 *    refusal throws `SyncLeaseRefusedError`, naming the holders, and
 *    nothing is written. A whole-file rewrite needs every block's lease.
 * 2. The write lands locally, and its lease is claimed for the next push.
 * 3. A cycle runs now: commit, push with the leases in the same atomic
 *    push as the branch. The tool call waits for it.
 * 4. If sync then rewrote the document (a race lost to someone's push: the
 *    merge ran, holder wins) or the lease was refused at push time, the
 *    write did land but not as written: `SyncWriteMergedError` says so and
 *    gives the document's current text, so the agent doesn't write again
 *    blind. ACP has no other way to tell a harness, so it is a failure
 *    result whose message says the write was saved.
 *
 * Writes a harness makes straight to disk never reach this gate: they are
 * racing writes, merged with holder-wins and flagged.
 */
import type { Hooks } from "@notefig/core";
import type { GatedWrite } from "@/modules/write-gate";
import { describeBlocks, holderLabel, type LeaseHolder } from "../lease-rules";
import type { SyncWorkerApi, SyncWritePlan } from "../sync-types";
import type { ClaimOutcome, Leases } from "./leases";
import { isMarkdownPath } from "./sync-merge-driver";

/** How long an agent's write waits for its push. */
export const GATE_PUSH_TIMEOUT_MS = 20_000;
/** How much of the current text a merge report carries. */
const REPORT_TEXT_LIMIT = 12_000;

const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;

const listHolders = (holders: readonly LeaseHolder[]) => {
  const names = holders.map(holderLabel);
  return names.length <= 1 ? (names[0] ?? "someone") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
};

/** A write the lease rule refused before anything was written. Shaped
 *  like the agent package's `AcpPathError`: the path, and a message the
 *  harness shows the model. */
export class SyncLeaseRefusedError extends Error {
  readonly name = "SyncLeaseRefusedError";
  constructor(
    readonly path: string,
    readonly holders: LeaseHolder[],
    message: string,
  ) {
    super(message);
  }
}

/** A write that landed, then was merged with someone else's edit. */
export class SyncWriteMergedError extends Error {
  readonly name = "SyncWriteMergedError";
  constructor(
    readonly path: string,
    readonly current: string,
    message: string,
  ) {
    super(message);
  }
}

export function refusalMessage(path: string, plan: Extract<SyncWritePlan, { granted: false }>): string {
  const name = fileName(path);
  if (plan.reason === "cap") {
    return `Refused: this write to ${name} changes more blocks than one writer may hold at once. Nothing was written. Make smaller, targeted edits.`;
  }
  const blocks = describeBlocks(plan.blocks);
  return (
    `Refused: block${plan.blocks.length === 1 ? "" : "s"} ${blocks} of ${name} ` +
    `${plan.blocks.length === 1 ? "is" : "are"} being edited by ${listHolders(plan.holders)}. ` +
    `Nothing was written. Make a targeted edit that leaves ${plan.blocks.length === 1 ? "that block" : "those blocks"} ` +
    `(and the blocks right next to them) alone, or try again once they have finished.`
  );
}

function mergedMessage(path: string, current: string, outcome: ClaimOutcome, merged: boolean): string {
  const lost =
    outcome.status === "refused"
      ? ` ${listHolders(outcome.refusal.holders)} got the lease on blocks you changed first, so their text wins where you both change them.`
      : "";
  const what = merged ? "was saved, then merged with a concurrent edit from a collaborator." : "was saved.";
  const text =
    current.length > REPORT_TEXT_LIMIT ? `${current.slice(0, REPORT_TEXT_LIMIT)}\n[…truncated]` : current;
  return (
    `Your write to ${fileName(path)} ${what}${lost} ` +
    `Don't write it again as it was. The document now reads:\n\n${text}`
  );
}

export interface LeaseGateDeps {
  root: string;
  api: Pick<SyncWorkerApi, "planWrite">;
  hooks: Hooks;
  leases: Leases;
  documents: { read(path: string): Promise<string> };
  /** `/`-separated workspace path of an absolute one; null outside. */
  treePath(absolute: string): string | null;
  /** Run a cycle (commit, push with leases) and wait for it. */
  syncNow(): Promise<void>;
  /** How many times sync has written `tree` so far (merges, pulls). */
  syncWrites(tree: string): number;
  setTimer(run: () => void, ms: number): () => void;
}

export function createLeaseGate(deps: LeaseGateDeps) {
  const waitForPush = async () => {
    let cancel = () => {};
    await Promise.race([
      deps.syncNow().catch(() => {}),
      new Promise<void>((resolve) => {
        cancel = deps.setTimer(resolve, GATE_PUSH_TIMEOUT_MS);
      }),
    ]);
    cancel();
  };

  const refuse = (write: GatedWrite, holder: LeaseHolder, plan: Extract<SyncWritePlan, { granted: false }>) => {
    deps.hooks.emit("sync:lease-refused", {
      workspacePath: deps.root,
      holder,
      path: write.path,
      holders: plan.holders,
      reason: plan.reason,
    });
    throw new SyncLeaseRefusedError(write.path, plan.holders, refusalMessage(write.path, plan));
  };

  return async (write: GatedWrite, perform: () => Promise<void>): Promise<void> => {
    const tree = deps.treePath(write.path);
    if (!tree || !isMarkdownPath(tree)) return perform();
    const holder = deps.leases.agentHolder(write.writer.taskId, write.writer.harness);
    // A new file has no blocks anyone could hold.
    const current = await deps.documents.read(write.path).catch(() => null);
    if (current !== null) {
      const plan = await deps.api.planWrite({ path: tree, current, content: write.content, holder });
      if (plan.ok && !plan.value.granted) refuse(write, holder, plan.value);
    }
    await perform();
    const before = deps.syncWrites(tree);
    const claim = deps.leases.claim({ holder, path: tree, content: write.content });
    try {
      await waitForPush();
    } finally {
      claim.drop();
    }
    const outcome = claim.outcome();
    const merged = deps.syncWrites(tree) !== before;
    if (!merged && outcome.status !== "refused") return;
    const now = await deps.documents.read(write.path).catch(() => null);
    if (now === null) return;
    throw new SyncWriteMergedError(write.path, now, mergedMessage(write.path, now, outcome, merged));
  };
}
