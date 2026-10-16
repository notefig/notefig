import { DurableObject } from "cloudflare:workers";
import {
  createWorkflowStore,
  REPORT_RETENTION_DAYS,
  type AdmitInput,
  type Resolution,
  type WorkflowStore,
} from "./store";

const PRUNE_EVERY_MS = 86_400_000;
const KEEP_COUNTERS_DAYS = 7;

/**
 * Holds one workflow's state; the Worker addresses it by workflow id
 * (`idFromName(workflow.id)`). Calls run one at a time, which keeps the
 * store's counters exact. A daily alarm drops old day counters and reports.
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

  saveReport(submissionId: string, text: string) {
    return this.#store.saveReport(submissionId, text);
  }

  report(reportId: string) {
    return this.#store.report(reportId);
  }

  reserveBuild(issueId: string, perDay: number) {
    return this.#store.reserveBuild(issueId, perDay);
  }

  prune(keep: { counterDays: number; reportDays: number }) {
    return this.#store.prune(keep);
  }

  async alarm() {
    await this.#store.prune({
      counterDays: KEEP_COUNTERS_DAYS,
      reportDays: REPORT_RETENTION_DAYS,
    });
    await this.ctx.storage.setAlarm(Date.now() + PRUNE_EVERY_MS);
  }
}
