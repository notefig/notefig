/**
 * Prompt rounds — every prompt-widget turn across the open workspaces, for
 * the sidebar's Everything view.
 *
 * A persisted row per round, written by one global listener: the widget
 * host announces `widget:round-started` when a prompt is sent (the turn,
 * the document, the prompt text) and the agent service announces
 * `agent:turn-settled` when the turn ends; nothing on the widget store or
 * the turn rows changes for this. A row that is still "live" when the app
 * comes back up belongs to a turn the previous run never finished — it is
 * settled as cancelled at boot. Read-side, rows join the open set: a
 * closed workspace's rounds stay stored and return when it reopens.
 *
 * A round is also its widget's record (MET-251): which widget sent it, the
 * full prompt, and — snapshotted when it settles — what it left behind
 * (`RoundOutcome`: the answer, the summary, the error, the files it
 * changed). The widget reads its settled face from here, so it reads the
 * same whether the turn ended a second ago or before a restart, and
 * whether or not a session revival has replayed its transcript away.
 * Settled rounds are kept for a week.
 */
import { createCollection } from "@tanstack/react-db";
import {
  persistedCollectionOptions,
  type PersistedCollectionPersistence,
} from "@tanstack/db-sqlite-persistence-core";
import { type AgentTurn, type AgentTurnStatus } from "@/modules/agents/react";
import type { AgentEntry } from "@notefig/shared/agent";
import {
  deriveRoundOutcome,
  type ReviewRangeStore,
  type RoundOutcome,
} from "@notefig/widgets";
import type { AgentStore } from "@/modules/agents/agent-collections";
import { type OpenWorkspaceRow } from "@/modules/workspaces";
import i18n from "@/utils/intl";
import { workspaceKey } from "@/utils/path";
import { defineModule, type CoreHookMap, type Hooks } from "@notefig/core";
import { agentStoreModule } from "@/modules/agents/agent-collections";
import { platformModule } from "@/core/services";

export const PROMPT_ROUNDS_COLLECTION_ID = "prompt-rounds";
/** Rows kept in storage across every workspace; the panel shows fewer.
 *  A safety net: a widget's newest round inside the retention window is
 *  never dropped for it. */
export const MAX_PROMPT_ROUNDS = 100;
/** How long a settled round — and with it its widget's done face — is
 *  kept. */
export const PROMPT_ROUND_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** "live" until the turn settles — queued vs running is read off the turn
 *  row while it exists. Once that row is gone the round is over: see
 *  `derivePromptRounds`. */
export type PromptRoundRowStatus =
  "live" | Extract<AgentTurnStatus, "completed" | "cancelled" | "error">;

export interface PromptRoundRow {
  /** The turn id — the row id. */
  turnId: string;
  taskId: string;
  workspaceKey: string;
  documentPath: string;
  /** The prompt as sent, first line. */
  prompt: string;
  status: PromptRoundRowStatus;
  startedAt: number;
  /** When the turn ended; read against the seen timestamps for attention. */
  settledAt?: number;
  /** The widget that sent it. Absent on rows from before MET-251. */
  blobId?: string;
  /** The workspace as the round's own paths spell it. */
  workspacePath?: string;
  /** The prompt as sent, whole — for Edit and Retry after a restart. */
  fullPrompt?: string;
  /** What the round left behind, written once when it settles. */
  outcome?: RoundOutcome;
  /** The ranges this round changed, per document, with the fingerprint of
   *  the document they were mapped onto (see documentFingerprint). */
  changes?: RoundChanges[];
}

export type RoundChanges = {
  documentPath: string;
  fingerprint: string;
  ranges: { from: number; to: number }[];
};

export interface PromptRound {
  turnId: string;
  taskId: string;
  workspacePath: string;
  documentPath: string;
  prompt: string;
  status: AgentTurnStatus;
  startedAt: number;
}

function createPromptRoundsCollection(
  persistence: PersistedCollectionPersistence,
) {
  return createCollection(
    persistedCollectionOptions<PromptRoundRow, string>({
      id: PROMPT_ROUNDS_COLLECTION_ID,
      getKey: (row) => row.turnId,
      persistence,
    }),
  );
}

export type PromptRoundsCollection = ReturnType<
  typeof createPromptRoundsCollection
>;

/** The note per turn status; a completed round has nothing to add. */
const ROUND_META_KEYS: Partial<Record<AgentTurnStatus, string>> = {
  running: "agentRunning",
  queued: "roundQueued",
  cancelled: "roundCancelled",
  error: "agentFailed",
};

/** A round's status note wherever it is listed, or null once it has
 *  completed — each list then trails what suits it. */
export function describePromptRound(
  round: Pick<PromptRound, "status">,
): string | null {
  const key = ROUND_META_KEYS[round.status];
  return key ? i18n.t(key) : null;
}

/** Still moving: in flight or waiting its turn. */
export function isLiveRound(round: Pick<PromptRound, "status">): boolean {
  return round.status === "running" || round.status === "queued";
}

function firstLine(text: string): string {
  return text.trim().split("\n", 1)[0] ?? "";
}

/** `core.promptRounds`: the stored rounds and the listener that keeps
 *  them. */
export interface PromptRoundsApi {
  readonly collection: PromptRoundsCollection;
  /** The listener's start half. */
  recordStarted(
    detail: CoreHookMap["widget:round-started"],
    now?: number,
  ): Promise<void>;
  /** The listener's settle half: only rounds we know are widget rounds. */
  recordSettled(detail: CoreHookMap["agent:turn-settled"]): Promise<void>;
  /** A round still "live" from a previous run never finished: settle it. */
  settleOrphaned(): Promise<void>;
  /** Boot: the one global listener. Returns the unsubscribe. */
  track(): () => void;
  /** Where the prompt widgets keep each document's review ranges: on the
   *  rounds that made them. */
  readonly reviewRanges: ReviewRangeStore;
}

export function createPromptRounds({
  persistence,
  turns,
  transcript,
  hooks,
}: {
  persistence: PersistedCollectionPersistence;
  turns: Pick<AgentStore["turns"], "get">;
  /** A turn's entries, read when it settles. */
  transcript: (turnId: string) => AgentEntry[];
  /** Where round starts and settled turns are announced. */
  hooks: Pick<Hooks, "on">;
}): PromptRoundsApi {
  const rounds = createPromptRoundsCollection(persistence);

  /** Keep storage bounded. */
  const prune = async (now: number) => {
    const doomed = roundsToEvict([...rounds.values()], now);
    if (doomed.length === 0) return;
    await rounds.delete(doomed).isPersisted.promise;
  };

  const api: PromptRoundsApi = {
    collection: rounds,
    reviewRanges: {
      load(documentPath) {
        const changes = [];
        let fingerprint: string | null = null;
        for (const row of rounds.values()) {
          const saved = row.changes?.find((c) => c.documentPath === documentPath);
          if (!saved) continue;
          fingerprint ??= saved.fingerprint;
          for (const range of saved.ranges) {
            changes.push({ blobId: row.blobId ?? "", turnId: row.turnId, ...range });
          }
        }
        return fingerprint === null ? null : { fingerprint, changes };
      },
      save(documentPath, { fingerprint, changes }) {
        const byTurn = new Map<string, { from: number; to: number }[]>();
        for (const { turnId, from, to } of changes) {
          byTurn.set(turnId, [...(byTurn.get(turnId) ?? []), { from, to }]);
        }
        const touched = [...rounds.values()]
          .filter(
            (row) =>
              byTurn.has(row.turnId) ||
              row.changes?.some((c) => c.documentPath === documentPath),
          )
          .map((row) => row.turnId);
        if (touched.length === 0) return;
        void rounds
          .update(touched, (drafts) => {
            for (const draft of drafts) {
              const others = (draft.changes ?? []).filter(
                (c) => c.documentPath !== documentPath,
              );
              const ranges = byTurn.get(draft.turnId);
              draft.changes = ranges
                ? [...others, { documentPath, fingerprint, ranges }]
                : others;
            }
          })
          .isPersisted.promise.catch((error) => {
            console.error("Failed to save review ranges:", error);
          });
      },
      forget(blobId) {
        const held = [...rounds.values()]
          .filter((row) => row.blobId === blobId && row.changes?.length)
          .map((row) => row.turnId);
        if (held.length === 0) return;
        void rounds
          .update(held, (drafts) => {
            for (const draft of drafts) draft.changes = [];
          })
          .isPersisted.promise.catch((error) => {
            console.error("Failed to forget review ranges:", error);
          });
      },
      subscribe(listener) {
        const subscription = rounds.subscribeChanges(listener);
        return () => subscription.unsubscribe();
      },
    },
    async recordStarted(detail, now = Date.now()) {
      await rounds.preload();
      if (rounds.get(detail.turnId)) return;
      await rounds.insert({
        turnId: detail.turnId,
        taskId: detail.taskId,
        workspaceKey: workspaceKey(detail.workspacePath),
        documentPath: detail.documentPath,
        prompt: firstLine(detail.prompt),
        status: "live",
        startedAt: now,
        ...(detail.blobId ? { blobId: detail.blobId } : {}),
        workspacePath: detail.workspacePath,
        fullPrompt: detail.prompt,
      }).isPersisted.promise;
      await prune(now);
    },
    async recordSettled(detail) {
      await rounds.preload();
      const row = rounds.get(detail.turnId);
      if (!row) return;
      // Snapshotted now: the transcript is in memory only, and a revival
      // replays it away.
      const outcome = deriveRoundOutcome({
        entries: transcript(detail.turnId),
        error: turns.get(detail.turnId)?.error,
        workspacePath: row.workspacePath ?? "",
      });
      await rounds.update(detail.turnId, (draft) => {
        draft.status = detail.status;
        draft.settledAt = detail.at;
        draft.outcome = outcome;
      }).isPersisted.promise;
    },
    async settleOrphaned() {
      await rounds.preload();
      await prune(Date.now());
      const orphaned = [...rounds.values()]
        .filter((row) => row.status === "live" && !turns.get(row.turnId))
        .map((row) => row.turnId);
      if (orphaned.length === 0) return;
      const now = Date.now();
      await rounds.update(orphaned, (drafts) => {
        for (const draft of drafts) {
          draft.status = "cancelled";
          draft.settledAt = now;
        }
      }).isPersisted.promise;
    },
    track() {
      void api.settleOrphaned().catch((error) => {
        console.error("Failed to settle orphaned prompt rounds:", error);
      });
      const stops = [
        hooks.on("widget:round-started", (detail) => {
          void api.recordStarted(detail).catch((error) => {
            console.error("Failed to record a prompt round:", error);
          });
        }),
        hooks.on("agent:turn-settled", (detail) => {
          void api.recordSettled(detail).catch((error) => {
            console.error("Failed to settle a prompt round:", error);
          });
        }),
      ];
      return () => stops.forEach((stop) => stop());
    },
  };
  return api;
}

/**
 * The rows to drop, pure — exported for tests. A settled round older than
 * the retention window goes. Past that, the oldest rows go until the cap
 * holds — except a widget's newest round still inside the window, which is
 * what its done face reads.
 */
export function roundsToEvict(rows: PromptRoundRow[], now: number): string[] {
  // A settled row without a settle time (one settled as orphaned before
  // it recorded one) ages from when it started.
  const expired = (row: PromptRoundRow) =>
    row.status !== "live" &&
    now - (row.settledAt ?? row.startedAt) > PROMPT_ROUND_RETENTION_MS;
  const doomed = new Set(rows.filter(expired).map((row) => row.turnId));
  const kept = rows
    .filter((row) => !doomed.has(row.turnId))
    .sort((a, b) => a.startedAt - b.startedAt);
  const newestByWidget = new Map<string, string>();
  for (const row of kept) {
    if (row.blobId) newestByWidget.set(row.blobId, row.turnId);
  }
  const protectedIds = new Set(newestByWidget.values());
  let excess = kept.length - MAX_PROMPT_ROUNDS;
  for (const row of kept) {
    if (excess <= 0) break;
    if (protectedIds.has(row.turnId)) continue;
    doomed.add(row.turnId);
    excess -= 1;
  }
  return [...doomed];
}

/** Live rounds first, then newest first within each group. */
function byActivity(a: PromptRound, b: PromptRound): number {
  const liveA = isLiveRound(a) ? 1 : 0;
  const liveB = isLiveRound(b) ? 1 : 0;
  if (liveA !== liveB) return liveB - liveA;
  return b.startedAt - a.startedAt;
}

/**
 * The stored rows joined to the open set and, while live, to the turn row
 * for queued-vs-running — pure, exported for tests.
 *
 * A live row whose turn row is gone reads as cancelled, the same answer
 * `settleOrphaned` writes at boot (MET-208). The turn row is the only
 * thing that can say a round is still moving, and several paths delete one
 * without settling it first — a withdrawn queued prompt, a purged task, a
 * revival replacing its history. Reading the absence as "running" pinned
 * those rounds live in the sidebar until the next launch.
 */
export function derivePromptRounds(
  rows: PromptRoundRow[],
  openWorkspaces: Pick<OpenWorkspaceRow, "key" | "path">[],
  turns: Pick<AgentTurn, "turnId" | "status">[],
): PromptRound[] {
  const pathByKey = new Map(openWorkspaces.map((row) => [row.key, row.path]));
  const turnById = new Map(turns.map((turn) => [turn.turnId, turn]));
  const rounds: PromptRound[] = [];
  for (const row of rows) {
    const workspacePath = pathByKey.get(row.workspaceKey);
    if (workspacePath === undefined) continue;
    const status: AgentTurnStatus =
      row.status === "live"
        ? (turnById.get(row.turnId)?.status ?? "cancelled")
        : row.status;
    rounds.push({
      turnId: row.turnId,
      taskId: row.taskId,
      workspacePath,
      documentPath: row.documentPath,
      prompt: row.prompt,
      status,
      startedAt: row.startedAt,
    });
  }
  return rounds.sort(byActivity);
}

declare module "@notefig/core" {
  interface CoreModules {
    promptRounds: PromptRoundsApi;
  }
}

/** Settles orphaned rounds, then follows prompt events. */
export const promptRoundsModule = defineModule({
  name: "promptRounds",
  needs: [platformModule, agentStoreModule],
  register: (ctx) => {
    const store = ctx.use("agentStore");
    return createPromptRounds({
      persistence: ctx.use("platform").db.get(),
      turns: store.turns,
      transcript: (turnId) =>
        store.entries.toArray.filter((entry) => entry.turnId === turnId),
      hooks: ctx.hooks,
    });
  },
  boot: (rounds) => rounds.track(),
});
