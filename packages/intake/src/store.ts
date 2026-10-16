/**
 * One workflow's state, over the key-value API of the Durable Object that
 * holds it (`WorkflowState`, one instance per workflow id). A Durable Object
 * runs one call at a time, so each method below reads and writes without
 * racing another submission — that is what makes the counters exact.
 *
 * Keys are built only here, under a version prefix: a later change of
 * record shape moves to `v2:` (migrating or dropping `v1:` keys) instead of
 * reading old records as new ones. Records hold hashes, never the submitted
 * text or the raw install id.
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
  createdAt: number;
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
  };
}

export type AdmitResult =
  /** Create the Linear issue, then `linkIssue` (or `abandon` on failure). */
  | { kind: "create" }
  /** Already reported by someone else: comment on `issueId` if there is one. */
  | { kind: "duplicate"; issueId?: string }
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
  /** Counts one agent run against today's cap; false when the cap is reached. */
  reserveAgentRun(perDay: number): Promise<boolean>;
  /** Deletes day counters older than `keepDays`. */
  prune(keepDays: number): Promise<void>;
}

const MAX_REPORTERS = 50;
const DAY_MS = 86_400_000;

const key = {
  submission: (id: string) => `v1:submission:${id}`,
  fingerprint: (hash: string) => `v1:fingerprint:${hash}`,
  issue: (issueId: string) => `v1:issue:${issueId}`,
  submitter: (hash: string) => `v1:submitter:${hash}`,
  counterPrefix: "v1:count:",
  counter: (day: string, name: string) => `v1:count:${day}:${name}`,
};

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
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

  async function reportAgain(
    existing: SubmissionRecord,
    submitter: string | undefined,
  ): Promise<AdmitResult> {
    if (existing.status === "declined") return { kind: "drop" };
    if (submitter && existing.reporters.includes(submitter)) return { kind: "drop" };
    if (submitter && existing.reporters.length < MAX_REPORTERS) {
      existing.reporters.push(submitter);
      await storage.put(key.submission(existing.id), existing);
    }
    return { kind: "duplicate", issueId: existing.issueId };
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
      const existingId = await storage.get<string>(key.fingerprint(fingerprint));
      const existing = existingId
        ? await storage.get<SubmissionRecord>(key.submission(existingId))
        : undefined;
      if (existing) return reportAgain(existing, submitter);
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
      if (!record) return;
      await storage.delete(key.submission(submissionId));
      await storage.delete(key.fingerprint(record.fingerprint));
    },

    async resolve(issueId, resolution) {
      const record = await submissionForIssue(issueId);
      if (!record) return;
      const wasDeclined = record.status === "declined";
      await storage.put(key.submission(record.id), { ...record, status: resolution });
      if (resolution !== "declined" || wasDeclined || !record.submitter) return;
      const submitterKey = key.submitter(record.submitter);
      const submitter = (await storage.get<SubmitterRecord>(submitterKey)) ?? { declined: 0 };
      await storage.put(submitterKey, { declined: submitter.declined + 1 });
    },

    async reserveAgentRun(perDay) {
      return (await bump("agent-runs")) <= perDay;
    },

    async prune(keepDays) {
      const oldest = utcDay(now() - keepDays * DAY_MS);
      const stale = await storage.list<number>({
        prefix: key.counterPrefix,
        end: key.counter(oldest, ""),
      });
      for (const counterKey of stale.keys()) await storage.delete(counterKey);
    },
  };
}
