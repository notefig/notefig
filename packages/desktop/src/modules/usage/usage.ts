/**
 * Usage — what agent turns have spent, kept as an hourly time series, and
 * where each harness account last stood against its limits.
 *
 * The agent subsystem keeps each session's own total on its task row; this
 * module keeps what outlives a session: one bucket per UTC hour, harness and
 * workspace, models inside it. It hears turns only through `agent:usage`
 * (harness quirks already resolved), so it never reaches the agent runtime
 * and deleting a session never touches its history here.
 *
 * Every bucket is a `UsageSummary`, kept by the same `addTurn` as the task
 * row's session total, so the levels add up the same way.
 *
 * History only grows, so the collection syncs on demand: nothing is loaded
 * at boot, and each view's hour range is read out of SQLite (indexed on
 * `hour`) when it is queried. Views group and add up what they loaded with
 * the pure functions in `series.ts`.
 */
import { BasicIndex, createCollection, eq, queryOnce } from "@tanstack/react-db";
import {
  persistedCollectionOptions,
  type PersistedCollectionPersistence,
} from "@tanstack/db-sqlite-persistence-core";
import {
  addTurn,
  emptySummary,
  newUsageBucketId,
  newUsageLimitsId,
  type UsageLimits,
  type UsageSummary,
} from "@notefig/shared/agent";
import { defineModule, type CoreHookMap, type Hooks } from "@notefig/core";
import { platformModule } from "@/core/services";
import { harnessesModule } from "@/modules/agents/harnesses";

export const USAGE_BUCKETS_COLLECTION_ID = "usage-buckets";
export const USAGE_LIMITS_COLLECTION_ID = "usage-limits";

const HOUR_MS = 3_600_000;

export type UsageBucket = UsageSummary & {
  /** usg_ — an entity id; buckets are found by `hour`, never by id. */
  bucketId: string;
  /** Epoch ms at the start of the UTC hour the bucket covers. */
  hour: number;
  harnessId: string;
  workspacePath: string;
};

/** A harness account's limits as last reported — one row per harness,
 *  replaced by each report. */
export type HarnessLimits = {
  /** ulm_ — minted when the harness first reported. */
  limitsId: string;
  harnessId: string;
  /** When the report arrived (epoch ms). */
  at: number;
  limits: UsageLimits;
};

/** The start of the UTC hour `at` falls in. */
export function startOfHour(at: number): number {
  return Math.floor(at / HOUR_MS) * HOUR_MS;
}

/** A new limits report over the stored one. A harness may report one
 *  window at a time (Claude names the window an event is about), so the
 *  windows it left out are kept until they reset; the rest — status,
 *  overage — is the new report's. */
export function mergeLimits(
  previous: UsageLimits,
  next: UsageLimits,
  at: number,
): UsageLimits {
  const reported = new Map(next.windows.map((window) => [window.id, window]));
  const windows = previous.windows
    .filter((window) => reported.has(window.id) || window.resetsAt === null || window.resetsAt > at)
    .map((window) => reported.get(window.id) ?? window);
  for (const window of next.windows) {
    if (!previous.windows.some((kept) => kept.id === window.id)) windows.push(window);
  }
  return { ...next, windows };
}

function createBucketsCollection(persistence: PersistedCollectionPersistence) {
  return createCollection(
    persistedCollectionOptions<UsageBucket, string>({
      id: USAGE_BUCKETS_COLLECTION_ID,
      getKey: (bucket) => bucket.bucketId,
      persistence,
      syncMode: "on-demand",
    }),
  );
}

export type UsageBucketsCollection = ReturnType<typeof createBucketsCollection>;

function createLimitsCollection(persistence: PersistedCollectionPersistence) {
  return createCollection(
    persistedCollectionOptions<HarnessLimits, string>({
      id: USAGE_LIMITS_COLLECTION_ID,
      getKey: (row) => row.limitsId,
      persistence,
    }),
  );
}

export type HarnessLimitsCollection = ReturnType<typeof createLimitsCollection>;

/** `core.usage`: the time series, read-only — it is written from the agent
 *  hooks alone. */
export interface UsageApi {
  readonly buckets: UsageBucketsCollection;
  /** One row per harness that has reported limits. Small, so loaded whole. */
  readonly limits: HarnessLimitsCollection;
  /** Resolves once every usage heard so far is durable. */
  settled(): Promise<void>;
  /** Boot: listen for turns' usage and harnesses' limits. Returns the
   *  unsubscribe. */
  track(): () => void;
}

export function createUsage({
  persistence,
  hooks,
}: {
  persistence: PersistedCollectionPersistence;
  /** Where settled turns' usage and harnesses' limits are announced. */
  hooks: Pick<Hooks, "on">;
}): UsageApi {
  const buckets = createBucketsCollection(persistence);
  const limits = createLimitsCollection(persistence);
  // Every query is an hour range; the index is mirrored into SQLite, which
  // is what keeps an on-demand range load from scanning the whole history.
  buckets.createIndex((bucket) => bucket.hour, { indexType: BasicIndex });

  /** The hour's bucket for this harness and workspace, loaded from SQLite
   *  if no view has it in memory. */
  const bucketFor = async (
    hour: number,
    harnessId: string,
    workspacePath: string,
  ): Promise<UsageBucket | undefined> => {
    const inHour = await queryOnce((q) =>
      q.from({ bucket: buckets }).where(({ bucket }) => eq(bucket.hour, hour)),
    );
    const found = inHour.find(
      (bucket) =>
        bucket.harnessId === harnessId && bucket.workspacePath === workspacePath,
    );
    return found && buckets.get(found.bucketId);
  };

  // Writes run one at a time, each to durability, so two turns landing in
  // the same hour (or two limit reports from one harness) can never both
  // find no row and insert two.
  let writes: Promise<void> = Promise.resolve();

  const write = async (detail: CoreHookMap["agent:usage"]): Promise<void> => {
    const hour = startOfHour(detail.at);
    const existing = await bucketFor(hour, detail.harnessId, detail.workspacePath);
    const transaction = existing
      ? buckets.update(existing.bucketId, (draft) => {
          // From the stored row, not the draft: draft proxies must not end
          // up inside the persisted value.
          const next = addTurn(existing, detail.usage);
          draft.total = next.total;
          draft.byModel = next.byModel;
          draft.turns = next.turns;
        })
      : buckets.insert(
          addTurn(
            {
              ...emptySummary(),
              bucketId: newUsageBucketId(),
              hour,
              harnessId: detail.harnessId,
              workspacePath: detail.workspacePath,
            },
            detail.usage,
          ),
        );
    await transaction.isPersisted.promise;
  };

  const writeLimits = async (
    detail: CoreHookMap["agent:usage-limits"],
  ): Promise<void> => {
    await limits.preload();
    const existing = limits.toArray.find((row) => row.harnessId === detail.harnessId);
    // Reports can arrive out of order across sessions; keep the newest.
    if (existing && existing.at > detail.at) return;
    const transaction = existing
      ? limits.update(existing.limitsId, (draft) => {
          const next = mergeLimits(existing.limits, detail.limits, detail.at);
          draft.at = detail.at;
          draft.limits = next;
        })
      : limits.insert({
          limitsId: newUsageLimitsId(),
          harnessId: detail.harnessId,
          at: detail.at,
          limits: detail.limits,
        });
    await transaction.isPersisted.promise;
  };

  const serialized =
    <T>(run: (detail: T) => Promise<void>, failure: string) =>
    (detail: T) => {
      writes = writes
        .then(() => run(detail))
        .catch((error) => console.error(failure, error));
    };
  const recordTurn = serialized(write, "Failed to record a turn's usage:");
  const recordLimits = serialized(writeLimits, "Failed to record a harness's limits:");

  return {
    buckets,
    limits,
    settled: () => writes,
    track() {
      const offUsage = hooks.on("agent:usage", recordTurn);
      const offLimits = hooks.on("agent:usage-limits", recordLimits);
      return () => {
        offUsage();
        offLimits();
      };
    },
  };
}

declare module "@notefig/core" {
  interface CoreModules {
    usage: UsageApi;
  }
}

/** Turns' usage, kept per hour beyond the sessions that spent it. */
export const usageModule = defineModule({
  name: "usage",
  // Harnesses: the views read what each one reports (`core.harnesses`).
  needs: [platformModule, harnessesModule],
  register: (ctx) =>
    createUsage({ persistence: ctx.use("platform").db.get(), hooks: ctx.hooks }),
  boot: (usage) => usage.track(),
});
