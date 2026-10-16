import { DurableObject } from "cloudflare:workers";
import {
  createWorkflowStore,
  type AdmitInput,
  type Resolution,
  type WorkflowStore,
} from "./store";

const PRUNE_EVERY_MS = 86_400_000;
const KEEP_COUNTERS_DAYS = 7;

/**
 * Holds one workflow's state; the Worker addresses it by workflow id
 * (`idFromName(workflow.id)`). Calls run one at a time, which keeps the
 * store's counters exact. A daily alarm drops old day counters.
 */
export class WorkflowState extends DurableObject<unknown> implements WorkflowStore {
  #store: WorkflowStore;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    this.#store = createWorkflowStore(ctx.storage);
    void ctx.blockConcurrencyWhile(async () => {
      if ((await ctx.storage.getAlarm()) === null) {
        await ctx.storage.setAlarm(Date.now() + PRUNE_EVERY_MS);
      }
    });
  }

  admit(input: AdmitInput) {
    return this.#store.admit(input);
  }

  linkIssue(submissionId: string, issueId: string) {
    return this.#store.linkIssue(submissionId, issueId);
  }

  abandon(submissionId: string) {
    return this.#store.abandon(submissionId);
  }

  resolve(issueId: string, resolution: Resolution) {
    return this.#store.resolve(issueId, resolution);
  }

  reserveAgentRun(perDay: number) {
    return this.#store.reserveAgentRun(perDay);
  }

  prune(keepDays: number) {
    return this.#store.prune(keepDays);
  }

  async alarm() {
    await this.#store.prune(KEEP_COUNTERS_DAYS);
    await this.ctx.storage.setAlarm(Date.now() + PRUNE_EVERY_MS);
  }
}
