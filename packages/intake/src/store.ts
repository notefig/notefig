/**
 * One workflow's state, over the key-value API of the Durable Object that
 * holds it (`WorkflowState`, one instance per workflow id). A Durable Object
 * runs one call at a time, so each method below reads and writes without
 * racing another submission — that is what makes the counters exact.
 *
 * Keys are built only here, under a version prefix: a later change of
 * record shape moves to `v2:` (migrating or dropping `v1:` keys) instead of
 * reading old records as new ones. Records hold hashes, never the submitted
 * text or the raw install id. The one exception is a private report (the
 * app's debug report), kept under a key that starts with the day it
 * arrived, so `prune` finds old ones by key range, and deleted early when
 * its issue is declined.
 */

/** The slice of DurableObjectStorage the store needs. */
export interface KeyValueStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T>(options: { prefix: string; end?: string }): Promise<Map<string, T>>;
}

export type SubmissionStatus = "pending" | "open" | "accepted" | "declined" | "duplicate";

export interface SubmissionRecord {
  id: string;
  fingerprint: string;
  submitter?: string;
  issueId?: string;
  status: SubmissionStatus;
  /** Hashed submitters who reported the same thing (capped). */
  reporters: string[];
  /** Ids of private reports sent with this submission or its duplicates. */
  reports?: string[];
  /** Accepting it took a slot of the day's build cap; a retried Accept reuses it. */
  buildReserved?: boolean;
  createdAt: number;
}

export interface StoredReport {
  submissionId: string;
  text: string;
  receivedAt: number;
}

interface SubmitterRecord {
  declined: number;
}

export interface AdmitInput {
  submissionId: string;
  /** Already hashed. */
  fingerprint: string;
  /** Already hashed. */
  submitter?: string;
  limits: {
    submissionsPerDay: number;
    perSubmitterPerDay: number;
    blockAfterDeclines: number;
    duplicatesPerDay: number;
  };
}

export type AdmitResult =
  /** Create the Linear issue, then `linkIssue` (or `abandon` on failure). */
  | { kind: "create" }
  /** Already reported by someone else: comment on `issueId` if there is one. */
  | { kind: "duplicate"; submissionId: string; issueId?: string }
  /** Over a limit: tell the client to try later. */
  | { kind: "limited" }
  /** Blocked submitter, declined report, or a repeat: accept and do nothing. */
  | { kind: "drop" };

export type Resolution = "accepted" | "declined" | "duplicate";

export interface WorkflowStore {
  admit(input: AdmitInput): Promise<AdmitResult>;
  linkIssue(submissionId: string, issueId: string): Promise<void>;
  abandon(submissionId: string): Promise<void>;
  resolve(issueId: string, resolution: Resolution): Promise<void>;
  /** Keeps a private report for a submission; returns its id. */
  saveReport(submissionId: string, text: string): Promise<string>;
  report(reportId: string): Promise<StoredReport | undefined>;
  /** Counts one build from an accepted issue; false when today's cap is reached. */
  reserveBuild(issueId: string, perDay: number): Promise<boolean>;
  /** Deletes day counters and reports older than the given number of days. */
  prune(keep: { counterDays: number; reportDays: number }): Promise<void>;
}

const MAX_REPORTERS = 50;
const DAY_MS = 86_400_000;
/**
 * A submission still pending this long was interrupted between admission
 * and its issue being created (the Worker stopped mid-request). Its
 * fingerprint is freed so the report can be sent again.
 */
const PENDING_TTL_MS = 10 * 60_000;

const key = {
  submission: (id: string) => `v1:submission:${id}`,
  fingerprint: (hash: string) => `v1:fingerprint:${hash}`,
  issue: (issueId: string) => `v1:issue:${issueId}`,
  submitter: (hash: string) => `v1:submitter:${hash}`,
  counterPrefix: "v1:count:",
  counter: (day: string, name: string) => `v1:count:${day}:${name}`,
  reportPrefix: "v1:report:",
  /** `reportId` starts with the day it arrived (yyyymmdd), so keys sort by age. */
  report: (reportId: string) => `v1:report:${reportId}`,
};

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** How long a private report is kept. */
export const REPORT_RETENTION_DAYS = 30;

/** A report id: the day it arrived, then a random part. */
export const REPORT_ID_PATTERN = /^\d{8}-[0-9a-f-]{36}$/;

function compactDay(ms: number): string {
  return utcDay(ms).replace(/-/g, "");
}

export function createWorkflowStore(
  storage: KeyValueStorage,
  now: () => number = Date.now,
): WorkflowStore {
  /** Increments today's counter and returns the new count. */
  async function bump(name: string): Promise<number> {
    const counterKey = key.counter(utcDay(now()), name);
    const count = ((await storage.get<number>(counterKey)) ?? 0) + 1;
    await storage.put(counterKey, count);
    return count;
  }

  async function isBlocked(submitter: string | undefined, after: number): Promise<boolean> {
    if (!submitter) return false;
    const record = await storage.get<SubmitterRecord>(key.submitter(submitter));
    return (record?.declined ?? 0) >= after;
  }

  /** The submission holding a fingerprint, unless it was interrupted (then freed). */
  async function liveSubmission(fingerprint: string): Promise<SubmissionRecord | undefined> {
    const id = await storage.get<string>(key.fingerprint(fingerprint));
    const record = id ? await storage.get<SubmissionRecord>(key.submission(id)) : undefined;
    if (record?.status !== "pending" || now() - record.createdAt <= PENDING_TTL_MS) return record;
    await forget(record);
    return undefined;
  }

  async function reportAgain(
    existing: SubmissionRecord,
    submitter: string | undefined,
    perDay: number,
  ): Promise<AdmitResult> {
    if (existing.status === "declined") return { kind: "drop" };
    // Each duplicate writes to Linear, so they share a daily ceiling too.
    if ((await bump("duplicates")) > perDay) return { kind: "drop" };
    if (submitter && existing.reporters.includes(submitter)) return { kind: "drop" };
    if (submitter && existing.reporters.length < MAX_REPORTERS) {
      existing.reporters.push(submitter);
      await storage.put(key.submission(existing.id), existing);
    }
    return { kind: "duplicate", submissionId: existing.id, issueId: existing.issueId };
  }

  async function deleteReports(record: SubmissionRecord): Promise<void> {
    for (const reportId of record.reports ?? []) await storage.delete(key.report(reportId));
  }

  /** Deletes a submission that never got its issue, freeing its fingerprint. */
  async function forget(record: SubmissionRecord): Promise<void> {
    await deleteReports(record);
    await storage.delete(key.submission(record.id));
    await storage.delete(key.fingerprint(record.fingerprint));
  }

  async function submissionForIssue(issueId: string): Promise<SubmissionRecord | undefined> {
    const submissionId = await storage.get<string>(key.issue(issueId));
    return submissionId ? storage.get<SubmissionRecord>(key.submission(submissionId)) : undefined;
  }

  return {
    async admit({ submissionId, fingerprint, submitter, limits }) {
      if (await isBlocked(submitter, limits.blockAfterDeclines)) return { kind: "drop" };
      if (submitter && (await bump(`submitter:${submitter}`)) > limits.perSubmitterPerDay) {
        return { kind: "limited" };
      }
      const existing = await liveSubmission(fingerprint);
      if (existing) return reportAgain(existing, submitter, limits.duplicatesPerDay);
      if ((await bump("submissions")) > limits.submissionsPerDay) return { kind: "limited" };

      const record: SubmissionRecord = {
        id: submissionId,
        fingerprint,
        submitter,
        status: "pending",
        reporters: submitter ? [submitter] : [],
        createdAt: now(),
      };
      await storage.put(key.submission(submissionId), record);
      await storage.put(key.fingerprint(fingerprint), submissionId);
      return { kind: "create" };
    },

    async linkIssue(submissionId, issueId) {
      const record = await storage.get<SubmissionRecord>(key.submission(submissionId));
      if (!record) return;
      await storage.put(key.submission(submissionId), { ...record, issueId, status: "open" });
      await storage.put(key.issue(issueId), submissionId);
    },

    async abandon(submissionId) {
      const record = await storage.get<SubmissionRecord>(key.submission(submissionId));
      if (record) await forget(record);
    },

    async resolve(issueId, resolution) {
      const record = await submissionForIssue(issueId);
      if (!record) return;
      const wasDeclined = record.status === "declined";
      if (resolution === "declined") await deleteReports(record);
      await storage.put(key.submission(record.id), {
        ...record,
        status: resolution,
        reports: resolution === "declined" ? [] : record.reports,
      });
      if (resolution !== "declined" || wasDeclined || !record.submitter) return;
      const submitterKey = key.submitter(record.submitter);
      const submitter = (await storage.get<SubmitterRecord>(submitterKey)) ?? { declined: 0 };
      await storage.put(submitterKey, { declined: submitter.declined + 1 });
    },

    async saveReport(submissionId, text) {
      const reportId = `${compactDay(now())}-${crypto.randomUUID()}`;
      const report: StoredReport = { submissionId, text, receivedAt: now() };
      await storage.put(key.report(reportId), report);
      const record = await storage.get<SubmissionRecord>(key.submission(submissionId));
      if (record) {
        const reports = [...(record.reports ?? []), reportId];
        await storage.put(key.submission(submissionId), { ...record, reports });
      }
      return reportId;
    },

    async report(reportId) {
      if (!REPORT_ID_PATTERN.test(reportId)) return undefined;
      return storage.get<StoredReport>(key.report(reportId));
    },

    async reserveBuild(issueId, perDay) {
      const record = await submissionForIssue(issueId);
      if (record?.buildReserved) return true;
      if ((await bump("builds")) > perDay) return false;
      if (record) await storage.put(key.submission(record.id), { ...record, buildReserved: true });
      return true;
    },

    async prune({ counterDays, reportDays }) {
      const staleCounters = await storage.list<number>({
        prefix: key.counterPrefix,
        end: key.counter(utcDay(now() - counterDays * DAY_MS), ""),
      });
      for (const counterKey of staleCounters.keys()) await storage.delete(counterKey);
      // Run daily, so this lists about one day's reports.
      const staleReports = await storage.list<never>({
        prefix: key.reportPrefix,
        end: key.report(compactDay(now() - reportDays * DAY_MS)),
      });
      for (const reportKey of staleReports.keys()) await storage.delete(reportKey);
    },
  };
}
