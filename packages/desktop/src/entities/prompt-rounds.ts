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
 */
import { useMemo } from "react";
import { createCollection, useLiveQuery } from "@tanstack/react-db";
import {
  persistedCollectionOptions,
  type PersistedCollectionPersistence,
} from "@tanstack/db-sqlite-persistence-core";
import {
  useAgentStore,
  type AgentTurn,
  type AgentTurnStatus,
} from "@/entities/agents";
import type { AgentStore } from "@/agent/agent-collections";
import { useOpenWorkspaces, type OpenWorkspaceRow } from "@/entities/workspaces";
import { onAppEvent, type AppEvents } from "@/utils/app-events";
import i18n from "@/utils/intl";
import { workspaceKey } from "@/utils/path";
import { defineModule } from "@notefig/core";
import { useModule } from "@notefig/core/react";

export const PROMPT_ROUNDS_COLLECTION_ID = "prompt-rounds";
/** Rows kept in storage across every workspace; the panel shows fewer. */
export const MAX_PROMPT_ROUNDS = 100;

/** "live" until the turn settles — queued vs running is read off the turn
 *  row while it exists. Once that row is gone the round is over: see
 *  `derivePromptRounds`. */
export type PromptRoundRowStatus =
  | "live"
  | Extract<AgentTurnStatus, "completed" | "cancelled" | "error">;

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
}

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
    detail: AppEvents["widget:round-started"],
    now?: number,
  ): Promise<void>;
  /** The listener's settle half: only rounds we know are widget rounds. */
  recordSettled(detail: AppEvents["agent:turn-settled"]): Promise<void>;
  /** A round still "live" from a previous run never finished: settle it. */
  settleOrphaned(): Promise<void>;
  /** Boot: the one global listener. Returns the unsubscribe. */
  track(): () => void;
}

export function createPromptRounds({
  persistence,
  turns,
}: {
  persistence: PersistedCollectionPersistence;
  turns: Pick<AgentStore["turns"], "get">;
}): PromptRoundsApi {
  const rounds = createPromptRoundsCollection(persistence);

  /** Keep storage bounded: drop the oldest rows past the cap. */
  const prune = async () => {
    const rows = [...rounds.values()].sort((a, b) => a.startedAt - b.startedAt);
    const excess = rows.length - MAX_PROMPT_ROUNDS;
    if (excess <= 0) return;
    await rounds.delete(rows.slice(0, excess).map((row) => row.turnId))
      .isPersisted.promise;
  };

  const api: PromptRoundsApi = {
    collection: rounds,
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
      }).isPersisted.promise;
      await prune();
    },
    async recordSettled(detail) {
      await rounds.preload();
      if (!rounds.get(detail.turnId)) return;
      await rounds.update(detail.turnId, (draft) => {
        draft.status = detail.status;
        draft.settledAt = detail.at;
      }).isPersisted.promise;
    },
    async settleOrphaned() {
      await rounds.preload();
      const orphaned = [...rounds.values()]
        .filter((row) => row.status === "live" && !turns.get(row.turnId))
        .map((row) => row.turnId);
      if (orphaned.length === 0) return;
      await rounds.update(orphaned, (drafts) => {
        for (const draft of drafts) draft.status = "cancelled";
      }).isPersisted.promise;
    },
    track() {
      void api.settleOrphaned().catch((error) => {
        console.error("Failed to settle orphaned prompt rounds:", error);
      });
      const stops = [
        onAppEvent("widget:round-started", (detail) => {
          void api.recordStarted(detail).catch((error) => {
            console.error("Failed to record a prompt round:", error);
          });
        }),
        onAppEvent("agent:turn-settled", (detail) => {
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

/**
 * The prompt rounds across every open workspace: live ones first, then the
 * most recent, capped at `limit`.
 */
export function usePromptRounds(limit: number): PromptRound[] {
  const rounds = useModule("promptRounds").collection;
  const store = useAgentStore();
  const { data: rows = [] } = useLiveQuery((q) => q.from({ round: rounds }));
  const { data: turns = [] } = useLiveQuery((q) =>
    q.from({ turn: store.turns }),
  );
  const openWorkspaces = useOpenWorkspaces();
  return useMemo(
    () => derivePromptRounds(rows, openWorkspaces, turns).slice(0, limit),
    [rows, openWorkspaces, turns, limit],
  );
}

declare module "@notefig/core" {
  interface CoreModules {
    promptRounds: PromptRoundsApi;
  }
}

/** Settles orphaned rounds, then follows prompt events. */
export const promptRoundsModule = defineModule({
  name: "promptRounds",
  needs: ["platform", "agentStore"],
  register: (ctx) =>
    createPromptRounds({
      persistence: ctx.use("platform").db.get(),
      turns: ctx.use("agentStore").turns,
    }),
  boot: (rounds) => rounds.track(),
});
