import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ChevronsDown, ChevronsUp } from "lucide-react";
import { cn } from "@notefig/ui/utils";
import { jumpToTask } from "@/components/agent/jump-to-task";
import { useWorkspaceTabs } from "@/components/workspace-tabs-provider";
import {
  useAgentRunsOverview,
  type AgentAttentionItem,
  type AgentTaskMeta,
} from "@/entities/agents";
import {
  useRecentDocuments,
  type RecentDocument,
} from "@/entities/recent-documents";
import { deriveProjectName } from "@/hooks/use-recent-projects";
import { getFileName } from "@/utils/fs";

const RECENT_DOCUMENTS_SHOWN = 8;
const ATTENTION_COLLAPSED_ROWS = 3;

interface EverythingPanelProps {
  activeTabId: string | null;
}

/**
 * The command-center view over every open workspace: the agent runs that
 * need the user, the ones still working, and the documents most recently
 * in front of the user, wherever they live.
 */
export function EverythingPanel({ activeTabId }: EverythingPanelProps) {
  const { t } = useTranslation();
  const overview = useAgentRunsOverview();
  const recentDocuments = useRecentDocuments(RECENT_DOCUMENTS_SHOWN);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-2 py-3">
      {overview.attention.length > 0 && (
        <AttentionGroup items={overview.attention} />
      )}

      {overview.working.length > 0 && (
        <Section title={t("agentRuns")}>
          {overview.working.map((meta) => (
            <WorkingRow key={meta.task.taskId} meta={meta} />
          ))}
        </Section>
      )}

      <Section title={t("recentDocuments")}>
        {recentDocuments.length === 0 ? (
          <p className="px-2 py-1 text-xs text-muted-foreground">
            {t("noRecentDocuments")}
          </p>
        ) : (
          recentDocuments.map((document) => (
            <RecentDocumentRow
              key={document.path}
              document={document}
              active={document.path === activeTabId}
            />
          ))
        )}
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-0.5">
      <h3 className="px-2 pb-1 text-xs font-medium text-muted-foreground">
        {title}
      </h3>
      {children}
    </section>
  );
}

/** The one row shape every list here uses: a leading glyph, a label that
 *  truncates, an optional trailing detail. */
function NavRow({
  leading,
  label,
  trailing,
  active,
  title,
  tabIndex,
  onClick,
  className,
}: {
  leading: ReactNode;
  label: string;
  trailing?: ReactNode;
  active?: boolean;
  title?: string;
  /** -1 keeps a row out of the tab order while its fold is closed. */
  tabIndex?: number;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      tabIndex={tabIndex}
      onClick={onClick}
      title={title ?? label}
      aria-current={active ? "true" : undefined}
      className={cn(
        "flex h-8 w-full items-center gap-2.5 rounded-lg px-2 text-start text-sm transition-colors",
        active ? "bg-accent" : "hover:bg-accent/60",
        className,
      )}
    >
      <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
        {leading}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {trailing}
    </button>
  );
}

function Dot({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("size-2 rounded-full", className)}
    />
  );
}

/** What an attention row says: the request itself when there is one. */
function attentionLabel(
  item: AgentAttentionItem,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  if (item.permission) return item.permission.title;
  return t(ATTENTION_LABEL_KEYS[item.kind], { title: item.task.title });
}

const ATTENTION_LABEL_KEYS: Record<AgentAttentionItem["kind"], string> = {
  permission: "attentionPermission",
  auth: "attentionAuth",
  unavailable: "attentionUnavailable",
  error: "attentionError",
};

/**
 * Runs waiting on the user, as a card. A row jumps to where the answer is
 * given — the prompt widget in the document when one is known, else the
 * chat tab — rather than answering here: the widget already carries the
 * request's own controls, in context.
 */
function AttentionGroup({ items }: { items: AgentAttentionItem[] }) {
  const { t } = useTranslation();
  const { openAgentTab } = useWorkspaceTabs();
  const [expanded, setExpanded] = useState(false);
  const overflow = items.length - ATTENTION_COLLAPSED_ROWS;
  const shown = expanded ? items : items.slice(0, ATTENTION_COLLAPSED_ROWS);

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm animate-in fade-in-0 duration-200 motion-reduce:animate-none">
      <div className="flex flex-col gap-0.5 p-1.5">
        <h3 className="px-2 pb-1 pt-0.5 text-xs font-medium text-muted-foreground">
          {t("needsAttention")}
        </h3>
        {shown.map((item) => (
          <NavRow
            key={item.task.taskId}
            leading={<Dot className="bg-destructive" />}
            label={attentionLabel(item, t)}
            title={`${attentionLabel(item, t)} · ${deriveProjectName(item.task.workspacePath)}`}
            onClick={() =>
              jumpToTask(item.task.taskId, { turnId: item.turnId, openAgentTab })
            }
          />
        ))}
      </div>
      {overflow > 0 && (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="flex h-8 w-full items-center gap-2.5 border-t border-border bg-muted/60 px-3.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <span className="flex size-4 items-center justify-center">
            {expanded ? (
              <ChevronsUp className="size-3.5" />
            ) : (
              <ChevronsDown className="size-3.5" />
            )}
          </span>
          {expanded ? t("showLess") : t("showMore", { count: overflow })}
        </button>
      )}
    </div>
  );
}

function WorkingRow({ meta }: { meta: AgentTaskMeta }) {
  const { openAgentTab } = useWorkspaceTabs();
  return (
    <NavRow
      leading={<Dot className="bg-brand animate-pulse" />}
      label={meta.task.title}
      title={`${meta.task.title} · ${deriveProjectName(meta.task.workspacePath)}`}
      onClick={() =>
        jumpToTask(meta.task.taskId, { turnId: null, openAgentTab })
      }
    />
  );
}

function RecentDocumentRow({
  document,
  active,
}: {
  document: RecentDocument;
  active: boolean;
}) {
  const { t } = useTranslation();
  const { openFile } = useWorkspaceTabs();
  return (
    <NavRow
      leading={
        <Dot
          className={
            active ? "bg-brand" : "border border-muted-foreground/60"
          }
        />
      }
      label={getFileName(document.path)}
      title={document.path}
      active={active}
      trailing={
        document.isScratchpad ? (
          <span className="shrink-0 text-xs text-muted-foreground">
            {t("scratchTag")}
          </span>
        ) : undefined
      }
      onClick={() => openFile({ tabId: document.path, intent: "replace" })}
    />
  );
}
