import { useCallback, useState } from "react";
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
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import { copyTextToClipboard } from "@/utils/clipboard";
import { useKv } from "@/utils/kv-store";
import { normalizePath } from "@/utils/fs";
import type { AgentTaskRow } from "@/agent/agent-collections";
import {
  cancelAgentTask,
  deleteAgentSession,
  refreshAgentSession,
  startAgentTask,
} from "@/agent/agent-service";
import { ensureAgentRuntime } from "@/agent/tunnel/require-connection";
import {
  describeTaskMeta,
  useAgentTaskList,
  useSessionActions,
} from "@/entities/agents";
import { useWorkspaceTabs } from "@/components/workspace-tabs-provider";
import { agentTabId } from "@/entities/tabs";
import {
  useActiveHarnesses,
  useDefaultHarness,
} from "@/hooks/use-harness-selection";
import { HarnessLogo } from "./harness-logo";

/**
 * The left-sidebar sessions menu (sidebarView === "sessions"): every agent
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
  const normalized = normalizePath(workspacePath);
  const { openAgentTab } = useWorkspaceTabs();
  const taskMetas = useAgentTaskList(workspacePath);

  const [trustPromptOpen, setTrustPromptOpen] = useState(false);
  // The harness the pending trust confirmation would start (picker choice).
  const [pendingHarness, setPendingHarness] = useState<HarnessDefinition>(
    BUILT_IN_HARNESSES[0],
  );
  const kv = useKv<boolean>("agent");
  const trustKey = `trust:${normalized}`;

  const startTask = useCallback(
    (harness: HarnessDefinition) => {
      // The row exists (status "starting") before startAgentTask returns —
      // open the tab right away rather than sitting on the multi-second
      // spawn/handshake; a failed start shows on the row as "error".
      const { taskId, started } = startAgentTask(workspacePath, harness);
      openAgentTab(taskId);
      started.catch((error) => {
        console.error("Failed to start agent task:", error);
      });
    },
    [workspacePath, openAgentTab],
  );

  const handleCreate = useCallback(
    (harness: HarnessDefinition) => {
      if (!ensureAgentRuntime()) return;
      if (kv.get(trustKey)) {
        startTask(harness);
      } else {
        setPendingHarness(harness);
        setTrustPromptOpen(true);
      }
    },
    [kv, trustKey, startTask],
  );

  const confirmTrust = useCallback(() => {
    kv.set(trustKey, true);
    setTrustPromptOpen(false);
    startTask(pendingHarness);
  }, [kv, trustKey, startTask, pendingHarness]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 items-center justify-between border-b border-sidebar-border px-2">
        <span className="text-xs font-medium text-muted-foreground">
          {t("agentSessions")}
        </span>
        <NewSessionButton onCreate={handleCreate} />
      </div>

      {taskMetas.length === 0 ? (
        <p className="p-3 text-xs text-muted-foreground">
          {t("agentNoSessions")}
        </p>
      ) : (
        <div className="flex-1 overflow-y-auto py-1">
          {taskMetas.map((meta) => (
            <SessionRow
              key={meta.task.taskId}
              task={meta.task}
              meta={describeTaskMeta(meta)}
              isRunning={meta.isRunning}
              active={agentTabId(meta.task.taskId) === activeTabId}
              onOpen={() => openAgentTab(meta.task.taskId)}
            />
          ))}
        </div>
      )}

      <AlertDialog open={trustPromptOpen} onOpenChange={setTrustPromptOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("agentTrustTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("agentTrustDescription", { harness: pendingHarness.label })}
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
    </div>
  );
}

export function SessionRow({
  task,
  meta,
  isRunning,
  active,
  onOpen,
}: {
  task: AgentTaskRow;
  meta: string;
  isRunning: boolean;
  active: boolean;
  onOpen: () => void;
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
          className={cn(
            "group flex w-full cursor-pointer items-center gap-2 px-2 py-1 text-xs transition-colors",
            active ? "bg-accent" : "hover:bg-accent/50",
          )}
        >
          <StatusDot status={task.status} />
          <span className="min-w-0 flex-1 truncate">{task.title}</span>
          <span className="shrink-0 text-[0.6875rem] text-muted-foreground">
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
                void cancelAgentTask(task.taskId);
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
function SessionRowMenu({ task }: { task: AgentTaskRow }) {
  const { t } = useTranslation();
  const actions = useSessionActions(task);
  return (
    <ContextMenuContent>
      <ContextMenuItem
        disabled={!actions.canRefresh}
        onSelect={() => refreshAgentSession(task.taskId)}
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
        onSelect={() => void deleteAgentSession(task.taskId)}
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
        className="h-7 gap-1 px-1.5 text-xs text-muted-foreground [&_svg]:size-3.5"
        title={t("agentNewSessionWith", { harness: defaultHarness.label })}
        aria-label={t("agentNewSessionWith", {
          harness: defaultHarness.label,
        })}
        onClick={() => onCreate(defaultHarness)}
      >
        <Plus />
        <HarnessLogo harnessId={defaultHarness.id} />
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-6 text-muted-foreground"
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

const STATUS_DOT_COLOR: Record<AgentTaskRow["status"], string> = {
  starting: "bg-amber-500",
  running: "bg-blue-500 animate-pulse",
  idle: "bg-green-500",
  // A restored session is a normal (idle-equivalent) session whose runtime
  // revives on first interaction (MET-54).
  restored: "bg-green-500",
  cancelled: "bg-muted-foreground",
  error: "bg-red-500",
  unavailable: "bg-red-500",
};

export function StatusDot({ status }: { status: AgentTaskRow["status"] }) {
  return (
    <span
      className={`h-2 w-2 shrink-0 rounded-full ${STATUS_DOT_COLOR[status]}`}
    />
  );
}
