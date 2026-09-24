import { useState, type ComponentType, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronsDown,
  ChevronsUp,
  CircleAlert,
  FolderPlus,
  MessageSquarePlus,
  MessageSquareText,
} from "lucide-react";
import { DropdownMenuTrigger } from "@notefig/ui/dropdown-menu";
import { findPromptBlobForTask } from "@notefig/widgets";
import { cn } from "@notefig/ui/utils";
import { jumpToTask } from "@/components/agent/jump-to-task";
import {
  SessionListRow,
  useStartSession,
} from "@/components/agent/sessions-panel";
import {
  StatusGlyph,
  attentionGlyphState,
  turnGlyphState,
} from "@/components/agent/status-glyph";
import { jumpToBlob } from "@/components/editor/blobs/jump-to-blob";
import { AddWorkspaceMenu } from "@/components/editor/global-column";
import { ScratchpadIcon } from "@/components/editor/scratchpad-icon";
import { SidebarSeparator } from "@/components/editor/tool-bar";
import { TOOL_ICONS } from "@/components/editor/workspace-tools";
import { useWorkspaceTabs } from "@/components/workspace-tabs-provider";
import { useAgentSessionList, type AgentTurnStatus } from "@/entities/agents";
import {
  mostPressing,
  useAttention,
  type AttentionItem,
  type AttentionKind,
} from "@/entities/attention";
import {
  isLiveRound,
  usePromptRounds,
  type PromptRound,
} from "@/entities/prompt-rounds";
import {
  useRecentDocuments,
  type RecentDocument,
} from "@/entities/recent-documents";
import { createAndOpenScratchpad } from "@/entities/scratchpads";
import { useDefaultHarness } from "@/hooks/use-harness-selection";
import { deriveProjectName } from "@/hooks/use-recent-projects";
import { formatTimeAgo } from "@/utils/format";
import { getFileName } from "@/utils/fs";

const ROUNDS_SHOWN = 6;
const SESSIONS_SHOWN = 6;
const FILES_SHOWN = 6;
const SCRATCHPADS_SHOWN = 4;
/** Fetched together, then split by kind. */
const RECENT_DOCUMENTS_FETCHED = 30;
const ATTENTION_COLLAPSED_ROWS = 3;

interface EverythingPanelProps {
  /** The focused workspace — where the quick actions create things. */
  workspacePath: string;
  activeTabId: string | null;
}

/**
 * The command-center view over every open workspace: quick ways to start
 * something, the runs that need the user, then what they were working with
 * most recently — prompt rounds in documents, agent sessions, files and
 * scratchpads — wherever it lives. Every list is a flat row list in the
 * sidebar's own idiom (the sessions panel, the file tree). What needs
 * attention is marked in place — a dot on the row and on its section's
 * title — except a question the agent is blocked on, which is the one
 * thing that gets a card, so it reads as the one thing that is asking.
 */
export function EverythingPanel({
  workspacePath,
  activeTabId,
}: EverythingPanelProps) {
  const { t } = useTranslation();
  const attention = useAttention();
  const rounds = usePromptRounds(ROUNDS_SHOWN);
  const sessions = useAgentSessionList(SESSIONS_SHOWN);
  const recentDocuments = useRecentDocuments(RECENT_DOCUMENTS_FETCHED);
  // Documents with a round in flight show it on their row too.
  const liveDocuments = new Set(
    rounds.filter(isLiveRound).map((round) => round.documentPath),
  );

  const renderDocument = (document: RecentDocument) => (
    <RecentDocumentRow
      key={document.path}
      document={document}
      active={document.path === activeTabId}
      live={liveDocuments.has(document.path)}
    />
  );
  // A section's title marks what it shows: a dot always has a row to open.
  const roundMarks = rounds.map((round) => attention.byRound.get(round.turnId) ?? null);
  const sessionMarks = sessions.map((meta) => attention.byTask.get(meta.task.taskId) ?? null);
  const sections = [
    listSection(
      MessageSquareText,
      t("promptRounds"),
      rounds,
      (round, index) => (
        <PromptRoundRow key={round.turnId} round={round} attention={roundMarks[index]} />
      ),
      roundMarks.reduce(mostPressing, null),
    ),
    listSection(
      TOOL_ICONS.sessions,
      t("agentSessions"),
      sessions,
      (meta) => (
        <SessionListRow
          key={meta.task.taskId}
          meta={meta}
          activeTabId={activeTabId}
          className={ROW_SHAPE_CLASS}
        />
      ),
      sessionMarks.reduce(mostPressing, null),
    ),
    listSection(
      TOOL_ICONS.files,
      t("everythingFiles"),
      recentDocuments.filter((d) => !d.isScratchpad).slice(0, FILES_SHOWN),
      renderDocument,
    ),
    listSection(
      ScratchpadIcon,
      t("everythingScratchpads"),
      recentDocuments.filter((d) => d.isScratchpad).slice(0, SCRATCHPADS_SHOWN),
      renderDocument,
    ),
  ].filter((section) => section !== null);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-1 py-2">
      <QuickActions workspacePath={workspacePath} />
      <SidebarSeparator className="mx-1 mt-2 shrink-0" />
      {attention.asks.length > 0 && <AttentionGroup items={attention.asks} />}
      {sections.length === 0 ? (
        <p className="p-3 text-xs text-muted-foreground">
          {t("everythingEmpty")}
        </p>
      ) : (
        sections
      )}
    </div>
  );
}

/** A titled row list, or nothing when there is nothing to list — so the
 *  view only ever shows what exists. */
type Glyph = ComponentType<{ className?: string; strokeWidth?: number | string }>;

function listSection<T>(
  icon: Glyph,
  title: string,
  items: T[],
  render: (item: T, index: number) => ReactNode,
  attention: AttentionKind | null = null,
): ReactNode {
  if (items.length === 0) return null;
  return (
    <section key={title} className="flex shrink-0 flex-col pt-4">
      <SectionTitle icon={icon} attention={attention}>
        {title}
      </SectionTitle>
      {items.map(render)}
    </section>
  );
}

function SectionTitle({
  icon: Icon,
  className,
  attention = null,
  children,
}: {
  icon: Glyph;
  className?: string;
  /** The section's most pressing mark, so a collapsed glance still sees it. */
  attention?: AttentionKind | null;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <h3
      className={cn(
        "flex items-center gap-2.5 px-2 pb-1 text-xs text-muted-foreground",
        className,
      )}
    >
      <Icon aria-hidden="true" className="size-3 shrink-0" strokeWidth={1.5} />
      <span className="truncate">{children}</span>
      {attention && (
        <span title={t("needsAttention")} className="flex shrink-0">
          <StatusGlyph state={attentionGlyphState(attention)} />
        </span>
      )}
    </h3>
  );
}

/** The sessions panel's row, as classes: a flat full-width row with a
 *  pointer cursor, hover wash and solid accent when active. */
/** Rows here are rounded — a list of pills in the card, not a table. */
const ROW_SHAPE_CLASS = "rounded-md";

function navRowClass(active?: boolean): string {
  return cn(
    "flex w-full cursor-pointer items-center gap-2.5 px-2 py-1.5 text-start text-xs transition-colors",
    ROW_SHAPE_CLASS,
    active ? "bg-accent" : "hover:bg-accent/50",
  );
}

const GLYPH_SLOT_CLASS =
  "flex size-3 shrink-0 items-center justify-center text-muted-foreground";

/**
 * The one row shape every list here uses: a leading glyph, a label that
 * truncates, a muted trailing note.
 */
function NavRow({
  leading,
  label,
  trailing,
  active,
  emphasis,
  title,
  onClick,
}: {
  leading: ReactNode;
  label: string;
  trailing?: ReactNode;
  active?: boolean;
  /** Weighted label — the row has news the user has not seen. */
  emphasis?: boolean;
  title?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title ?? label}
      aria-current={active ? "true" : undefined}
      className={navRowClass(active)}
    >
      <span className={GLYPH_SLOT_CLASS}>{leading}</span>
      <span className={cn("min-w-0 flex-1 truncate", emphasis && "font-medium")}>
        {label}
      </span>
      {trailing !== undefined && (
        <span className="shrink-0 text-[0.6875rem] text-muted-foreground/80">
          {trailing}
        </span>
      )}
    </button>
  );
}

/** Ways to start something in the focused workspace, at the top so they
 *  are one click from anywhere. The "open project" row opens the rail's
 *  add-workspace menu, so both entry points offer the same choices. */
function QuickActions({ workspacePath }: { workspacePath: string }) {
  const { t } = useTranslation();
  const { openFile } = useWorkspaceTabs();
  const { defaultHarness } = useDefaultHarness();
  const { create, trustDialog } = useStartSession(workspacePath);
  return (
    <div className="flex shrink-0 flex-col">
      <NavRow
        leading={<ScratchpadIcon className="size-3" />}
        label={t("newScratchpad")}
        onClick={() => createAndOpenScratchpad(workspacePath, openFile)}
      />
      <NavRow
        leading={<MessageSquarePlus className="size-3" strokeWidth={1.5} />}
        label={t("agentNewSession")}
        title={t("agentNewSessionWith", { harness: defaultHarness.label })}
        onClick={() => create(defaultHarness)}
      />
      <AddWorkspaceMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            title={t("openProject")}
            className={navRowClass()}
          >
            <span className={GLYPH_SLOT_CLASS}>
              <FolderPlus className="size-3" strokeWidth={1.5} />
            </span>
            <span className="min-w-0 flex-1 truncate">{t("openProject")}</span>
          </button>
        </DropdownMenuTrigger>
      </AddWorkspaceMenu>
      {trustDialog}
    </div>
  );
}

/** What an ask says: the request itself when there is one. */
function askLabel(
  item: AttentionItem,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  if (item.permission) return item.permission.title;
  return t("attentionAuth", { title: item.task?.title ?? "" });
}

/**
 * The questions the agent is blocked on, as a card. A row jumps to where
 * the answer is given — the prompt widget in the document when one is
 * known, else the chat tab — rather than answering here: the widget already
 * carries the request's own controls, in context.
 */
function AttentionGroup({ items }: { items: AttentionItem[] }) {
  const { t } = useTranslation();
  const { openAgentTab } = useWorkspaceTabs();
  const [expanded, setExpanded] = useState(false);
  const overflow = items.length - ATTENTION_COLLAPSED_ROWS;
  const shown = expanded ? items : items.slice(0, ATTENTION_COLLAPSED_ROWS);

  return (
    <div className="mx-1 mt-4 shrink-0 overflow-hidden rounded-lg border border-border/70 bg-card animate-in fade-in-0 duration-200 motion-reduce:animate-none">
      <div className="flex flex-col p-1 pt-1.5">
        <SectionTitle icon={CircleAlert} className="pt-0.5">
          {t("needsAttention")}
        </SectionTitle>
        {shown.map((item) => (
          <NavRow
            key={item.taskId}
            leading={<StatusGlyph state={attentionGlyphState(item.kind)} />}
            label={askLabel(item, t)}
            title={`${askLabel(item, t)} · ${deriveProjectName(item.task?.workspacePath ?? "")}`}
            trailing={formatTimeAgo(item.since)}
            onClick={() =>
              jumpToTask(item.taskId, { turnId: item.turnId, openAgentTab })
            }
          />
        ))}
      </div>
      {overflow > 0 && (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="flex w-full cursor-pointer items-center gap-2.5 bg-muted/40 px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <span className={GLYPH_SLOT_CLASS}>
            {expanded ? (
              <ChevronsUp className="size-3" strokeWidth={1.5} />
            ) : (
              <ChevronsDown className="size-3" strokeWidth={1.5} />
            )}
          </span>
          {expanded ? t("showLess") : t("showMore", { count: overflow })}
        </button>
      )}
    </div>
  );
}

/** The trailing note per turn status; settled rounds show when they ran. */
const ROUND_META_KEYS: Partial<Record<AgentTurnStatus, string>> = {
  running: "agentRunning",
  queued: "roundQueued",
  cancelled: "roundCancelled",
  error: "agentFailed",
};

/** A prompt-widget round: the prompt, its state, and a jump back to the
 *  widget in its document. */
function PromptRoundRow({
  round,
  attention,
}: {
  round: PromptRound;
  /** Settled since the user last had its document in front. */
  attention: AttentionKind | null;
}) {
  const { t } = useTranslation();
  const { openFile } = useWorkspaceTabs();
  const metaKey = ROUND_META_KEYS[round.status];
  const label = round.prompt || getFileName(round.documentPath);
  // The widget itself when it is mounted this run; else its document.
  const jump = () => {
    const widget = findPromptBlobForTask(round.taskId, round.turnId);
    if (widget && widget.boundTurnId === round.turnId) {
      jumpToBlob(widget.documentPath, widget.blobId);
    } else {
      openFile({ tabId: round.documentPath, intent: "replace" });
    }
  };
  return (
    <NavRow
      leading={
        <StatusGlyph
          state={
            attention ? attentionGlyphState(attention) : turnGlyphState(round.status)
          }
        />
      }
      emphasis={attention !== null}
      label={label}
      title={`${label} · ${getFileName(round.documentPath)} · ${deriveProjectName(round.workspacePath)}`}
      trailing={metaKey ? t(metaKey) : formatTimeAgo(round.startedAt)}
      onClick={jump}
    />
  );
}

/** The recents marker: a hairline ring, filled in the brand colour for
 *  the document in front of the user. */
function Marker({ filled }: { filled: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        filled ? "bg-brand" : "border border-muted-foreground/70",
      )}
    />
  );
}

function RecentDocumentRow({
  document,
  active,
  live,
}: {
  document: RecentDocument;
  active: boolean;
  /** A prompt round is running in this document. */
  live: boolean;
}) {
  const { openFile } = useWorkspaceTabs();
  return (
    <NavRow
      leading={
        live ? <StatusGlyph state="running" /> : <Marker filled={active} />
      }
      label={getFileName(document.path)}
      title={`${document.path} · ${deriveProjectName(document.workspacePath)}`}
      active={active}
      trailing={deriveProjectName(document.workspacePath)}
      onClick={() => openFile({ tabId: document.path, intent: "replace" })}
    />
  );
}
