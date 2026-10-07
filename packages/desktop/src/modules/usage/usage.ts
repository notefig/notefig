/**
 * Usage — what agent turns have spent, kept as an hourly time series.
 *
 * The agent subsystem keeps each session's own total on its task row; this
 * module keeps what outlives a session: one bucket per UTC hour, harness and
 * workspace, models inside it. It hears turns only through `agent:usage`
 * (harness quirks already resolved), so it never reaches the agent runtime
 * and deleting a session never touches its history here.
 *
 * Every bucket is a `UsageSummary`, kept by the same `addTurn` as the task
 * row's session total, so the levels add up the same way.
 */
import { BasicIndex, createCollection } from "@tanstack/react-db";
import {
  persistedCollectionOptions,
  type PersistedCollectionPersistence,
} from "@tanstack/db-sqlite-persistence-core";
import {
  addModelUsage,
  addSummary,
  addTurn,
  emptySummary,
  newUsageBucketId,
  type ModelUsage,
  type UsageSummary,
} from "@notefig/shared/agent";
import { defineModule, type CoreHookMap, type Hooks } from "@notefig/core";
import { platformModule } from "@/core/services";

export const USAGE_BUCKETS_COLLECTION_ID = "usage-buckets";

const HOUR_MS = 3_600_000;

export type UsageBucket = UsageSummary & {
  /** usg_ — an ascending entity id minted at `hour`, so ids sort by hour. */
  bucketId: string;
  /** Epoch ms at the start of the UTC hour the bucket covers. */
  hour: number;
  harnessId: string;
  workspacePath: string;
};

export type UsageTotals = {
  all: UsageSummary;
  byHarness: Record<string, UsageSummary>;
  byModel: ModelUsage[];
};

/** The start of the UTC hour `at` falls in. */
export function startOfHour(at: number): number {
  return Math.floor(at / HOUR_MS) * HOUR_MS;
}

/** Add buckets up: overall, per harness, and per model. */
export function totalsOf(buckets: readonly UsageBucket[]): UsageTotals {
  let all = emptySummary();
  const byHarness: Record<string, UsageSummary> = {};
  let byModel: ModelUsage[] = [];
  for (const bucket of buckets) {
    all = addSummary(all, bucket);
    byHarness[bucket.harnessId] = addSummary(
      byHarness[bucket.harnessId] ?? emptySummary(),
      bucket,
    );
    byModel = addModelUsage(byModel, bucket.byModel);
  }
  return { all, byHarness, byModel };
}

function createBucketsCollection(persistence: PersistedCollectionPersistence) {
  return createCollection(
    persistedCollectionOptions<UsageBucket, string>({
      id: USAGE_BUCKETS_COLLECTION_ID,
      getKey: (bucket) => bucket.bucketId,
      persistence,
    }),
  );
}

export type UsageBucketsCollection = ReturnType<typeof createBucketsCollection>;

/** `core.usage`: the time series and what keeps it. */
export interface UsageApi {
  readonly buckets: UsageBucketsCollection;
  /** The listener's body: fold one turn into its hour's bucket. */
  recordTurn(detail: CoreHookMap["agent:usage"]): Promise<void>;
  /** Boot: listen for turns' usage. Returns the unsubscribe. */
  track(): () => void;
}

export function createUsage({
  persistence,
  hooks,
}: {
  persistence: PersistedCollectionPersistence;
  /** Where settled turns' usage is announced. */
  hooks: Pick<Hooks, "on">;
}): UsageApi {
  const buckets = createBucketsCollection(persistence);
  const bucketsByHour = buckets.createIndex((bucket) => bucket.hour, {
    indexType: BasicIndex,
  });

  const bucketFor = (
    hour: number,
    harnessId: string,
    workspacePath: string,
  ): UsageBucket | undefined => {
    for (const key of bucketsByHour.equalityLookup(hour)) {
      const bucket = buckets.get(String(key));
      if (
        bucket &&
        bucket.harnessId === harnessId &&
        bucket.workspacePath === workspacePath
      ) {
        return bucket;
      }
    }
    return undefined;
  };

  // Writes run one at a time, each to durability, so two turns landing in
  // the same hour can never both find no bucket and insert two.
  let writes: Promise<void> = Promise.resolve();

  const write = async (detail: CoreHookMap["agent:usage"]): Promise<void> => {
    await buckets.preload();
    const hour = startOfHour(detail.at);
    const existing = bucketFor(hour, detail.harnessId, detail.workspacePath);
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
              bucketId: newUsageBucketId(hour),
              hour,
              harnessId: detail.harnessId,
              workspacePath: detail.workspacePath,
            },
            detail.usage,
          ),
        );
    await transaction.isPersisted.promise;
  };

  const api: UsageApi = {
    buckets,
    recordTurn(detail) {
      const next = writes.then(() => write(detail));
      writes = next.catch(() => {});
      return next;
    },
    track() {
      return hooks.on("agent:usage", (detail) => {
        void api.recordTurn(detail).catch((error) => {
          console.error("Failed to record a turn's usage:", error);
        });
      });
    },
  };
  return api;
}

declare module "@notefig/core" {
  interface CoreModules {
    usage: UsageApi;
  }
}

/** Turns' usage, kept per hour beyond the sessions that spent it. */
export const usageModule = defineModule({
  name: "usage",
  needs: [platformModule],
  register: (ctx) =>
    createUsage({ persistence: ctx.use("platform").db.get(), hooks: ctx.hooks }),
  boot: (usage) => usage.track(),
});
