/**
 * The app's status for outside the window — the Everything view's model,
 * cut to what a glance can take: the newest few prompts, recent files and
 * sessions, each marked as its sidebar row is, plus the general ways in.
 * Derived here, from the same hooks the sidebar reads, and handed to the
 * platform through `ui.publishAppStatus`; nothing here knows what the
 * platform draws it as.
 */
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { platformAdapter } from "@/adapters";
import type {
  AppStatus,
  AppStatusAction,
  AppStatusSection,
  StatusMark,
} from "@/adapters/platform-adapter.interface";
import { jumpToRound, jumpToTask } from "@/components/agent/jump-to-task";
import {
  attentionGlyphState,
  taskGlyphState,
  turnGlyphState,
} from "@/components/agent/status-glyph";
import {
  describeTaskMeta,
  useAgentSessionList,
  type AgentTaskMeta,
} from "@/entities/agents";
import {
  useAttention,
  type Attention,
  type AttentionItem,
} from "@/entities/attention";
import {
  MAX_PROMPT_ROUNDS,
  describePromptRound,
  isLiveRound,
  usePromptRounds,
  type PromptRound,
} from "@/entities/prompt-rounds";
import {
  useRecentDocuments,
  type RecentDocument,
} from "@/entities/recent-documents";
import { createAndOpenScratchpad } from "@/entities/scratchpads";
import { useOpenProjectFromPicker } from "@/hooks/use-open-project";
import { deriveProjectName } from "@/hooks/use-recent-projects";
import type { OpenFileInLayoutOptions } from "@/utils/dockable-layout";
import { getFileName } from "@/utils/fs";

/** Rows per section: a glance, not the sidebar. */
export const APP_STATUS_ROWS = 3;
/** A prompt's first line can run long; the menu should not. */
const LABEL_CHARS = 48;

/** Where an entry opens into. Absent (the welcome screen), there is
 *  nothing to open an entry into, so nothing is listed. */
export interface AppStatusTabs {
  openFile: (options: OpenFileInLayoutOptions) => boolean;
  openAgentTab: (taskId: string) => void;
}

export interface AppStatusHost {
  /** The focused workspace — where a new scratchpad goes; null on welcome. */
  workspacePath: string | null;
  tabs: AppStatusTabs | null;
  openWorkspace: () => void;
  openSettings: () => void;
}

export interface AppStatusInputs {
  host: AppStatusHost;
  /** Every round, live first: a document's "running" is read off all of
   *  them, not just the few listed. */
  rounds: PromptRound[];
  sessions: AgentTaskMeta[];
  documents: RecentDocument[];
  attention: Pick<Attention, "items" | "overall" | "byRound" | "byTask">;
  t: (key: string) => string;
}

function clip(label: string): string {
  return label.length > LABEL_CHARS ? `${label.slice(0, LABEL_CHARS - 1)}…` : label;
}

function roundMark(
  round: PromptRound,
  attention: AppStatusInputs["attention"],
): StatusMark {
  const kind = attention.byRound.get(round.turnId);
  return kind ? attentionGlyphState(kind) : turnGlyphState(round.status);
}

function sessionMark(
  meta: AgentTaskMeta,
  attention: AppStatusInputs["attention"],
): StatusMark {
  const kind = attention.byTask.get(meta.task.taskId);
  return kind ? attentionGlyphState(kind) : taskGlyphState(meta.task);
}

/** Where an attention item would be listed, were it recent enough. */
function listedIdOf(item: AttentionItem): string {
  return item.target.kind === "document"
    ? `prompts:${item.turnId}`
    : `sessions:${item.taskId}`;
}

/**
 * The sidebar's "needs attention" card, for what the recency cut leaves
 * out: an unseen result or an ask on a fourth session still lights the
 * dot, so the menu must still have a row for it.
 */
function attentionSection(
  { attention, t }: AppStatusInputs,
  listed: AppStatusSection[],
  tabs: AppStatusTabs,
): AppStatusSection {
  const listedIds = new Set(listed.flatMap((s) => s.entries.map((e) => e.id)));
  const leftOut = attention.items.filter((item) => !listedIds.has(listedIdOf(item)));
  return {
    id: "attention",
    title: t("needsAttention"),
    entries: leftOut.slice(0, APP_STATUS_ROWS).map((item) => ({
      id: `attention:${item.taskId}:${item.turnId}`,
      label: clip(
        item.target.kind === "document"
          ? getFileName(item.target.id)
          : (item.task?.title ?? item.taskId),
      ),
      detail: deriveProjectName(item.workspaceKey),
      mark: attentionGlyphState(item.kind),
      activate: () =>
        item.target.kind === "document" && item.turnId
          ? jumpToRound(
              { taskId: item.taskId, turnId: item.turnId, documentPath: item.target.id },
              tabs.openFile,
            )
          : jumpToTask(item.taskId, { turnId: item.turnId, openAgentTab: tabs.openAgentTab }),
    })),
  };
}

/** The three recency sections in the sidebar's order, the attention card
 *  ahead of them when it has rows, empty ones left out. */
function sections(
  inputs: AppStatusInputs,
  tabs: AppStatusTabs,
): AppStatusSection[] {
  const { rounds, sessions, documents, attention, t } = inputs;
  const liveDocuments = new Set(
    rounds.filter(isLiveRound).map((round) => round.documentPath),
  );
  const all: AppStatusSection[] = [
    {
      id: "prompts",
      title: t("promptRounds"),
      entries: rounds.slice(0, APP_STATUS_ROWS).map((round) => ({
        id: `prompts:${round.turnId}`,
        label: clip(round.prompt || getFileName(round.documentPath)),
        // A completed round names where its result is: a relative time
        // would sit stale in a menu that only redraws on change.
        detail: describePromptRound(round) ?? getFileName(round.documentPath),
        mark: roundMark(round, attention),
        activate: () => jumpToRound(round, tabs.openFile),
      })),
    },
    {
      id: "documents",
      title: t("recentDocuments"),
      entries: documents.map((document) => ({
        id: `documents:${document.path}`,
        label: clip(getFileName(document.path)),
        detail: deriveProjectName(document.workspacePath),
        mark: liveDocuments.has(document.path) ? "running" : undefined,
        activate: () =>
          tabs.openFile({ tabId: document.path, intent: "replace" }),
      })),
    },
    {
      id: "sessions",
      title: t("agentSessions"),
      entries: sessions.map((meta) => ({
        id: `sessions:${meta.task.taskId}`,
        label: clip(meta.task.title),
        // A settled session names its project — the sidebar's "time ago"
        // would sit stale here.
        detail: describeTaskMeta(meta) ?? deriveProjectName(meta.task.workspacePath),
        mark: sessionMark(meta, attention),
        activate: () => tabs.openAgentTab(meta.task.taskId),
      })),
    },
  ];
  return [attentionSection(inputs, all, tabs), ...all].filter(
    (section) => section.entries.length > 0,
  );
}

function actions({ host, t }: AppStatusInputs): AppStatusAction[] {
  const list: AppStatusAction[] = [
    { id: "open-workspace", label: t("openProject"), activate: host.openWorkspace },
  ];
  if (host.workspacePath !== null && host.tabs !== null) {
    const { workspacePath, tabs } = host;
    list.push({
      id: "new-scratchpad",
      label: t("newScratchpad"),
      activate: () => createAndOpenScratchpad(workspacePath, tabs.openFile),
    });
  }
  list.push({ id: "settings", label: t("settings"), activate: host.openSettings });
  return list;
}

/** Pure, for tests: the status as a function of what the sidebar shows. */
export function deriveAppStatus(inputs: AppStatusInputs): AppStatus {
  const { host, attention } = inputs;
  // No tabs (welcome), no rows — and no dot, which would point at nothing.
  const overall = host.tabs ? attention.overall : null;
  return {
    attention: overall && attentionGlyphState(overall),
    sections: host.tabs ? sections(inputs, host.tabs) : [],
    actions: actions(inputs),
  };
}

/**
 * Mount once per shell (the workspace, the welcome screen): keeps the
 * platform told the current status. Publishing is cheap — the adapter
 * ignores a value that draws the same — so this republishes on any change.
 */
export function usePublishAppStatus(
  host: Omit<AppStatusHost, "openWorkspace">,
): void {
  const { t } = useTranslation();
  const attention = useAttention();
  const rounds = usePromptRounds(MAX_PROMPT_ROUNDS);
  const sessions = useAgentSessionList(APP_STATUS_ROWS);
  const documents = useRecentDocuments(APP_STATUS_ROWS);
  const openWorkspace = useOpenProjectFromPicker();
  const { workspacePath, tabs, openSettings } = host;
  useEffect(() => {
    platformAdapter.ui.publishAppStatus(
      deriveAppStatus({
        host: { workspacePath, tabs, openSettings, openWorkspace },
        rounds,
        sessions,
        documents,
        attention,
        t,
      }),
    );
  }, [workspacePath, tabs, openSettings, openWorkspace, rounds, sessions, documents, attention, t]);
}
