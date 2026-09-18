import { useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ChevronsDown, ChevronsUp, Folder, Plus } from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@notefig/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@notefig/ui/dropdown-menu";
import { cn } from "@notefig/ui/utils";
import { jumpToTask } from "@/components/agent/jump-to-task";
import { useCloseWorkspace } from "@/components/editor/close-workspace-dialog";
import { TOOL_ICONS, TOOL_LABEL_KEYS } from "@/components/editor/workspace-tools";
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
import { useOpenWorkspaces, type OpenWorkspaceRow } from "@/entities/workspaces";
import {
  useOpenProject,
  useOpenProjectFromPicker,
} from "@/hooks/use-open-project";
import {
  deriveProjectName,
  useRecentProjects,
} from "@/hooks/use-recent-projects";
import {
  WORKSPACE_TOOLS,
  type WorkspaceTool,
} from "@/hooks/use-workspace-panels";
import { getFileName } from "@/utils/fs";
import { workspaceKey } from "@/utils/path";

const RECENT_DOCUMENTS_SHOWN = 8;
const ATTENTION_COLLAPSED_ROWS = 3;
const MAX_RECENT_IN_MENU = 5;

interface EverythingPanelProps {
  /** The focused workspace — the project whose tools are unfolded. */
  workspacePath: string;
  activeTabId: string | null;
  onShowWorkspaceTools: (path: string) => void;
  onShowTool: (tool: WorkspaceTool) => void;
}

/**
 * The command-center view over every open workspace: the agent runs that
 * need the user, the ones still working, the open projects — the focused
 * one unfolded into its tools — and the documents most recently in front
 * of the user, wherever they live.
 */
export function EverythingPanel({
  workspacePath,
  activeTabId,
  onShowWorkspaceTools,
  onShowTool,
}: EverythingPanelProps) {
  const { t } = useTranslation();
  const overview = useAgentRunsOverview();
  const recentDocuments = useRecentDocuments(RECENT_DOCUMENTS_SHOWN);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-2 pb-3 pt-1">
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

      <ProjectsSection
        workspacePath={workspacePath}
        counts={overview.byWorkspace}
        onShowWorkspaceTools={onShowWorkspaceTools}
        onShowTool={onShowTool}
      />

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

/**
 * The open workspaces. The focused one unfolds its tools beneath it — a
 * grid-row track animates 0fr → 1fr, so nothing is measured — and any
 * other becomes the focused one on click. A right-click closes.
 */
function ProjectsSection({
  workspacePath,
  counts,
  onShowWorkspaceTools,
  onShowTool,
}: {
  workspacePath: string;
  counts: ReturnType<typeof useAgentRunsOverview>["byWorkspace"];
  onShowWorkspaceTools: (path: string) => void;
  onShowTool: (tool: WorkspaceTool) => void;
}) {
  const { t } = useTranslation();
  const rows = useOpenWorkspaces();
  const { requestClose, dialog } = useCloseWorkspace();
  const focusedKey = workspaceKey(workspacePath);

  return (
    <Section title={t("projects")}>
      {rows.map((row) => (
        <ProjectRow
          key={row.key}
          row={row}
          attention={counts.get(row.key)?.attention ?? 0}
          focused={row.key === focusedKey}
          onFocus={() => onShowWorkspaceTools(row.path)}
          onShowTool={onShowTool}
          onClose={() => requestClose(row.path)}
        />
      ))}
      <AddWorkspaceRow />
      {dialog}
    </Section>
  );
}

function ProjectRow({
  row,
  attention,
  focused,
  onFocus,
  onShowTool,
  onClose,
}: {
  row: OpenWorkspaceRow;
  attention: number;
  focused: boolean;
  onFocus: () => void;
  onShowTool: (tool: WorkspaceTool) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const name = deriveProjectName(row.path);
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div data-project={row.key}>
          <NavRow
            leading={<Folder className="size-4" />}
            label={name}
            title={row.path}
            active={focused}
            onClick={onFocus}
            trailing={
              attention > 0 ? (
                <span className="rounded-full bg-destructive/10 px-1.5 text-xs font-medium text-destructive">
                  {attention}
                </span>
              ) : undefined
            }
          />
          <div
            aria-hidden={!focused}
            className={cn(
              "grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none",
              focused ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
            )}
          >
            <div className="min-h-0 overflow-hidden">
              <div className="flex flex-col gap-0.5 py-0.5 ps-4">
                {WORKSPACE_TOOLS.map((tool) => {
                  const Icon = TOOL_ICONS[tool];
                  return (
                    <NavRow
                      key={tool}
                      leading={<Icon className="size-3.5" />}
                      label={t(TOOL_LABEL_KEYS[tool])}
                      tabIndex={focused ? undefined : -1}
                      onClick={() => onShowTool(tool)}
                      className="h-7 text-[0.8125rem] text-muted-foreground hover:text-foreground"
                    />
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={onClose}>
          {t("closeWorkspaceAction")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** "Add workspace": recent projects not yet open, then the folder picker. */
function AddWorkspaceRow() {
  const { t } = useTranslation();
  const openProject = useOpenProject();
  const openFolder = useOpenProjectFromPicker();
  const { recentProjects } = useRecentProjects();
  const openRows = useOpenWorkspaces();

  const otherProjects = useMemo(() => {
    const openKeys = new Set(openRows.map((row) => row.key));
    return recentProjects
      .filter((project) => !openKeys.has(workspaceKey(project.path)))
      .slice(0, MAX_RECENT_IN_MENU);
  }, [recentProjects, openRows]);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex h-8 w-full items-center gap-2.5 rounded-lg px-2 text-start text-sm text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
        >
          <span className="flex size-4 items-center justify-center">
            <Plus className="size-4" />
          </span>
          <span className="truncate">{t("addWorkspace")}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-52">
        {otherProjects.length > 0 && (
          <>
            <DropdownMenuLabel className="py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
              {t("recentWorkspaces")}
            </DropdownMenuLabel>
            {otherProjects.map((project) => (
              <DropdownMenuItem
                key={project.path}
                className="py-1 text-xs"
                onSelect={() => void openProject(project.path)}
              >
                <span className="truncate">{project.name}</span>
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuItem
          className="py-1 text-xs"
          onSelect={() => void openFolder()}
        >
          {t("openFolder")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
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
