import { ToolBar } from "@/components/editor/tool-bar";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import {
  Check,
  ChevronDown,
  Copy,
  Plus,
  RefreshCw,
  Square,
  Terminal,
  Trash2,
} from "lucide-react";
import type { HarnessDefinition } from "@notefig/shared/agent";
import { BUILT_IN_HARNESSES } from "@notefig/shared/agent";
import { Button } from "@notefig/ui/button";
import { ButtonGroup } from "@notefig/ui/button-group";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@notefig/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@notefig/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@notefig/ui/alert-dialog";
import { cn } from "@notefig/ui/utils";
import { copyTextToClipboard } from "@notefig/ui/clipboard";
import type { AgentTaskRow } from "@/agent/agent-collections";
import {
  agents,
  describeTaskMeta,
  useAgentTaskList,
  type AgentTaskMeta,
  useSessionActions,
} from "@/entities/agents";
import { useCore } from "@notefig/core/react";
import { agentTabId } from "@/entities/tabs";
import {
  useActiveHarnesses,
  useDefaultHarness,
} from "@/hooks/use-harness-selection";
import { HarnessLogo } from "@notefig/ui/harness-logo";
import {
  StatusGlyph,
  attentionGlyphState,
  taskGlyphState,
} from "@/components/agent/status-glyph";
import { useAttention, type AttentionKind } from "@/entities/attention";
import { formatTimeAgo } from "@/utils/format";

/**
 * The left-sidebar sessions tool (sidebarView === "sessions"): every agent
 * session in the workspace, last-activity ordered with live status meta.
 * Clicking a row opens (or focuses) that session's dockable chat tab; the
 * `+` menu starts a new session on a chosen harness — behind the same
 * per-workspace trust gate the inline prompt blob uses — and opens its tab.
 * This is the only list of sessions; chat tabs are pinned to one task each.
 */
export function SessionsPanel({
  workspacePath,
  activeTabId,
}: {
  workspacePath: string;
  activeTabId: string | null;
}) {
  const { t } = useTranslation();
  const taskMetas = useAgentTaskList(workspacePath);

  const { create, trustDialog } = useStartSession(workspacePath);

  return (
    <div className="flex h-full flex-col">
      <ToolBar className="justify-start">
        <NewSessionButton onCreate={create} />
      </ToolBar>

      {taskMetas.length === 0 ? (
        <p className="p-3 text-xs text-muted-foreground">
          {t("agentNoSessions")}
        </p>
      ) : (
        <div className="flex-1 overflow-y-auto py-1">
          {taskMetas.map((meta) => (
            <SessionListRow
              key={meta.task.taskId}
              meta={meta}
              activeTabId={activeTabId}
            />
          ))}
        </div>
      )}

      {trustDialog}
    </div>
  );
}

/**
 * Starting a session in a workspace, trust gate included: the first start
 * in a workspace asks once (the answer is kept per workspace), later ones
 * go straight through. Shared by the sessions panel's split button and the
 * Everything view's quick action, so both start sessions the same way.
 */
export function useStartSession(workspacePath: string): {
  create: (harness: HarnessDefinition) => void;
  /** Mount once near the caller: the one-time trust confirmation. */
  trustDialog: ReactNode;
} {
  const { t } = useTranslation();
  const [trustPromptOpen, setTrustPromptOpen] = useState(false);
  // What the pending trust confirmation would start, and where: a start
  // resolves after a load, by when the panel may show another workspace.
  const [pending, setPending] = useState<{
    workspacePath: string;
    harness: HarnessDefinition;
  }>({ workspacePath, harness: BUILT_IN_HARNESSES[0] });
  const shownWorkspace = useRef(workspacePath);
  shownWorkspace.current = workspacePath;
  // The question is about the workspace that asked: once the panel shows
  // another one, an open dialog goes rather than answer for the wrong one.
  useEffect(() => {
    if (pending.workspacePath !== workspacePath) setTrustPromptOpen(false);
  }, [pending.workspacePath, workspacePath]);

  const create = useCallback(
    (harness: HarnessDefinition) => {
      const requested = workspacePath;
      void agents
        .workspace(requested)
        .start(harness)
        .then((result) => {
          if (result.status !== "needs-trust") return;
          // Asked about the workspace on screen, or not at all.
          if (shownWorkspace.current !== requested) return;
          setPending({ workspacePath: requested, harness });
          setTrustPromptOpen(true);
        });
    },
    [workspacePath],
  );

  const confirmTrust = useCallback(() => {
    const workspace = agents.workspace(pending.workspacePath);
    workspace.trust();
    setTrustPromptOpen(false);
    void workspace.start(pending.harness);
  }, [pending]);

  const trustDialog = (
    <AlertDialog open={trustPromptOpen} onOpenChange={setTrustPromptOpen}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("agentTrustTitle")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("agentTrustDescription", { harness: pending.harness.label })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
          <AlertDialogAction onClick={confirmTrust}>
            {t("agentTrustConfirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  return { create, trustDialog };
}

/** A task from a session list, rendered as its row: the derived meta label,
 *  active when its chat tab is the active one, opening that tab on click.
 *  Shared by the workspace's sessions panel and the Everything view. */
export function SessionListRow({
  meta,
  activeTabId,
  className,
}: {
  meta: AgentTaskMeta;
  activeTabId: string | null;
  className?: string;
}) {
  const { tabs } = useCore();
  const { byTask } = useAttention();
  return (
    <SessionRow
      className={className}
      task={meta.task}
      meta={describeTaskMeta(meta) ?? formatTimeAgo(meta.task.updatedAt)}
      isRunning={meta.isRunning}
      attention={byTask.get(meta.task.taskId) ?? null}
      active={agentTabId(meta.task.taskId) === activeTabId}
      onOpen={() => tabs.openAgent(meta.task.taskId)}
    />
  );
}

export function SessionRow({
  task,
  meta,
  isRunning,
  active,
  onOpen,
  className,
  attention = null,
}: {
  task: AgentTaskRow;
  meta: string;
  isRunning: boolean;
  active: boolean;
  onOpen: () => void;
  className?: string;
  /** Something to point the user at here (entities/attention.ts). */
  attention?: AttentionKind | null;
}) {
  const { t } = useTranslation();
  return (
    // Flat full-width rows, same affordances as the file tree / commit
    // list: pointer cursor (Tailwind's preflight defaults buttons to the
    // arrow cursor), hover wash, solid accent when active. Session actions
    // live on the row's context menu (SessionRowMenu).
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          onClick={onOpen}
          title={task.title}
          data-session-row={task.taskId}
          data-session-status={task.status}
          className={cn(
            "group flex w-full cursor-pointer items-center gap-2.5 px-2 py-1.5 text-xs transition-colors",
            active ? "bg-accent" : "hover:bg-accent/50",
            className,
          )}
        >
          <span className="flex size-3 shrink-0 items-center justify-center">
            <StatusGlyph
              // What needs attention outranks the status: an ask or a
              // failure is what the run is blocked on. (A finished-turn mark
              // never coexists with a running session — entities/attention.)
              state={attention ? attentionGlyphState(attention) : taskGlyphState(task)}
            />
          </span>
          <span className={cn("min-w-0 flex-1 truncate", attention && "font-medium")}>
            {task.title}
          </span>
          <span className="shrink-0 text-[0.6875rem] text-muted-foreground/80">
            {meta}
          </span>
          {isRunning && (
            <button
              type="button"
              title={t("agentStopSession")}
              aria-label={t("agentStopSession")}
              className="hidden shrink-0 cursor-pointer rounded p-0.5 text-muted-foreground hover:text-foreground group-hover:block"
              onClick={(event) => {
                event.stopPropagation();
                void agents.task(task.taskId).cancel();
              }}
            >
              <Square className="size-3 fill-current" />
            </button>
          )}
        </div>
      </ContextMenuTrigger>
      <SessionRowMenu task={task} />
    </ContextMenu>
  );
}

/**
 * The session row's context menu: refresh from the harness store, copy the
 * session id / terminal resume command, delete. The right-click-then-click
 * gesture is deliberate enough that delete needs no extra confirm step (it
 * replaced the MET-91 two-step inline trash button).
 */
export function SessionRowMenu({ task }: { task: AgentTaskRow }) {
  const { t } = useTranslation();
  const actions = useSessionActions(task);
  return (
    <ContextMenuContent>
      <ContextMenuItem
        disabled={!actions.canRefresh}
        onSelect={() => agents.task(task.taskId).refresh()}
      >
        <RefreshCw />
        {t("agentRefreshSession")}
      </ContextMenuItem>
      <ContextMenuItem
        disabled={actions.sessionId === null}
        onSelect={() => void copyTextToClipboard(actions.sessionId ?? "")}
      >
        <Copy />
        {t("agentCopySessionId")}
      </ContextMenuItem>
      {actions.resume.supported && (
        <ContextMenuItem
          disabled={actions.resume.command === null}
          onSelect={() =>
            void copyTextToClipboard(actions.resume.command ?? "")
          }
        >
          <Terminal />
          {t("agentCopyResumeCommand")}
        </ContextMenuItem>
      )}
      <ContextMenuSeparator />
      <ContextMenuItem
        className="text-destructive focus:text-destructive"
        onSelect={() => void agents.task(task.taskId).delete()}
      >
        <Trash2 />
        {t("agentDeleteSession")}
      </ContextMenuItem>
    </ContextMenuContent>
  );
}

/**
 * Git-commit-style split button: the main button starts a session on the
 * default harness immediately (no picker in the way); the chevron opens the
 * harness list — only active (signed-in) harnesses — and picking one starts
 * on it AND remembers it as the new default.
 */
function NewSessionButton({
  onCreate,
}: {
  onCreate: (harness: HarnessDefinition) => void;
}) {
  const { t } = useTranslation();
  const { defaultHarness, setDefaultHarness } = useDefaultHarness();
  const harnesses = useActiveHarnesses();

  return (
    <ButtonGroup>
      <Button
        variant="ghost"
        className="h-6 gap-1 px-1.5 text-xs font-normal text-muted-foreground [&_svg]:size-3"
        title={t("agentNewSessionWith", { harness: defaultHarness.label })}
        aria-label={t("agentNewSessionWith", {
          harness: defaultHarness.label,
        })}
        onClick={() => onCreate(defaultHarness)}
      >
        <Plus />
        <HarnessLogo harnessId={defaultHarness.id} />
        <span className="truncate">{defaultHarness.label}</span>
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-5 text-muted-foreground [&_svg]:size-3"
            title={t("agentChooseHarness")}
            aria-label={t("agentChooseHarness")}
          >
            <ChevronDown className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {harnesses.map((harness) => (
            <DropdownMenuItem
              key={harness.id}
              onSelect={() => {
                setDefaultHarness(harness.id);
                onCreate(harness);
              }}
            >
              <HarnessLogo harnessId={harness.id} />
              <span className="flex-1">{harness.label}</span>
              {harness.id === defaultHarness.id && (
                <Check className="size-3.5 shrink-0" />
              )}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </ButtonGroup>
  );
}

