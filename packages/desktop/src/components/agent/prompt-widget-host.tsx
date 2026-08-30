/**
 * The app's implementation of @notefig/widgets' PromptWidgetHost — the one
 * place the prompt widget and this application are wired together.
 *
 * The widget package cannot import from the app (that is the point of the
 * extraction), so everything it needs from here arrives through this object:
 * the agent service, the live collections, the shared per-workspace session,
 * the workspace file index, the tab layout, and the four rendered surfaces
 * the app owns. If you are looking for "how does the widget do X", X is
 * either a method below or it never leaves the package.
 *
 * Constructed once per workspace and memoized: the object identity feeds
 * hook dependency arrays inside the widget, so a fresh one per render would
 * re-run its effects.
 */
import { useMemo } from "react";
import { useLiveQuery, eq, and } from "@tanstack/react-db";
import type {
  MentionCandidate,
  PromptRound,
  PromptWidgetHost,
  SessionOption,
} from "@notefig/widgets";
import { extractMentionPaths } from "@notefig/widgets";
import type { PromptContextPart } from "@notefig/shared/agent";
import {
  agentEntriesCollection,
  agentPermissionRequestsCollection,
  agentTasksCollection,
  agentTurnsCollection,
} from "@/agent/agent-collections";
import { agents } from "@/agent/agents";
import {
  cancelAgentTask,
  cancelAgentTurnAndForget,
  removeQueuedPrompt,
} from "@/agent/agent-service";
import { ensureAgentRuntime } from "@/agent/tunnel/require-connection";
import { describeTaskMeta, useAgentTaskList } from "@/entities/agents";
import { getOrCreateWorkspaceCollections } from "@/entities/files";
import { useDefaultHarness } from "@/hooks/use-harness-selection";
import { canOpenFile } from "@/components/editor/polymorphic-editor";
import { FileTypeIcon } from "@/components/editor/file-type-icon";
import { Markdown } from "@/components/ui/markdown";
import { useWorkspaceTabs } from "@/components/workspace-tabs-provider";
import { requestTabFocus, suppressTabFocus } from "@/tabs/tab-controllers";
import { rankFileRows } from "@/utils/file-score";
import { useKv } from "@/utils/kv-store";
import { path as pathutil, relativeTreePath, workspaceKey } from "@/utils/path";
import { AuthCard } from "./auth-card";
import { PermissionCard } from "./permission-card";
import {
  adoptSharedSession,
  dropSharedSession,
  getOrStartSharedSession,
  peekSharedSession,
} from "./blob-session-store";

/** Does this tree-domain token name a real file in the workspace? The
 *  workspace path must stay byte-identical to the collection's workspaceId
 *  (rows are keyed by NATIVE absolute paths derived from it), so the join
 *  reproduces that spelling exactly — no normalization anywhere here. */
function isWorkspaceFile(workspacePath: string, token: string): boolean {
  const { metadata } = getOrCreateWorkspaceCollections(workspacePath);
  const row = metadata.get(
    pathutil.join(workspacePath, pathutil.fromTreePath(token)),
  );
  return row !== undefined && row.type === "file";
}

function searchWorkspaceFiles(
  workspacePath: string,
  query: string,
  limit: number,
): MentionCandidate[] {
  const { metadata } = getOrCreateWorkspaceCollections(workspacePath);
  // The raw collection holds directory rows too (useFileSearch's live query
  // filters them; a one-shot read must do it itself).
  const files = metadata.toArray.filter((row) => row.type === "file");
  return rankFileRows(files, query, {
    limit,
    filter: canOpenFile,
    matchAllWhenEmpty: true,
  });
}

/**
 * A prompt's @-mentions as resource_link context parts. URIs are file://
 * (not notefig://widget-context): the MCP server's resources/read only
 * decodes widget-context URIs, so mention links must be readable by the
 * harness's own file tools.
 */
export function mentionContextParts(
  workspacePath: string,
  text: string,
): PromptContextPart[] {
  const isFile = (token: string) => isWorkspaceFile(workspacePath, token);
  return extractMentionPaths(text, isFile).map((token) => ({
    kind: "resource_link" as const,
    path: pathutil.toFileUri(
      pathutil.join(workspacePath, pathutil.fromTreePath(token)),
    ),
    name: token,
  }));
}

/**
 * The widget's bound round, as live rows. Sentinel ids keep the queries
 * unconditional: an unbound widget still runs them, matching nothing.
 */
function useRound({
  turnId,
  taskId,
}: {
  turnId: string | null;
  taskId: string | null;
}): PromptRound {
  const turnKey = turnId ?? " none";
  const taskKey = taskId ?? " none";
  const { data: turnRows = [] } = useLiveQuery(
    (q) =>
      q
        .from({ turn: agentTurnsCollection })
        .where(({ turn }) => eq(turn.turnId, turnKey)),
    [turnKey],
  );
  const { data: taskRows = [] } = useLiveQuery(
    (q) =>
      q
        .from({ task: agentTasksCollection })
        .where(({ task }) => eq(task.taskId, taskKey)),
    [taskKey],
  );
  const { data: entries = [] } = useLiveQuery(
    (q) =>
      q
        .from({ entry: agentEntriesCollection })
        .where(({ entry }) => eq(entry.turnId, turnKey)),
    [turnKey],
  );
  const { data: taskTurns = [] } = useLiveQuery(
    (q) =>
      q
        .from({ turn: agentTurnsCollection })
        .where(({ turn }) => eq(turn.taskId, taskKey)),
    [taskKey],
  );
  const { data: pendingPermissions = [] } = useLiveQuery(
    (q) =>
      q
        .from({ req: agentPermissionRequestsCollection })
        .where(({ req }) =>
          and(eq(req.taskId, taskKey), eq(req.status, "pending")),
        ),
    [taskKey],
  );

  return {
    turn: turnRows[0],
    task: taskRows[0],
    entries,
    taskTurns,
    pendingPermissions,
  };
}

/** Live sessions for the widget's picker, newest first. */
function useSessionList(workspacePath: string): SessionOption[] {
  const metas = useAgentTaskList(workspacePath);
  return useMemo(
    () =>
      metas
        .filter(
          (meta) =>
            meta.task.status !== "error" &&
            meta.task.status !== "cancelled" &&
            meta.task.status !== "unavailable",
        )
        .map((meta) => ({
          taskId: meta.task.taskId,
          title: meta.task.title,
          description: describeTaskMeta(meta),
          harnessId: meta.task.harnessId,
        })),
    [metas],
  );
}

const slots: PromptWidgetHost["slots"] = {
  Markdown,
  // `bare`: the widget already wraps these in an equivalently-tinted card,
  // so they skip their own border/bg/padding.
  PermissionCard: ({ taskId }) => <PermissionCard taskId={taskId} bare />,
  AuthCard: ({ task }) => <AuthCard task={task} bare />,
  FileIcon: FileTypeIcon,
};

/**
 * Build the host. Workspace-agnostic: every method takes the workspace path
 * it applies to, so one instance serves every editor and chat tab in the app.
 *
 * The `use*` members are hooks the WIDGET calls from its own components —
 * they are passed here unbound on purpose, and must never be invoked inside
 * this function.
 */
export function usePromptWidgetHost(): PromptWidgetHost {
  const { openFile, openAgentTab } = useWorkspaceTabs();
  const { defaultHarness } = useDefaultHarness();
  const kv = useKv<boolean>("agent");

  return useMemo<PromptWidgetHost>(
    () => ({
      startOrGetSharedSession: async (path) =>
        (await getOrStartSharedSession(path, defaultHarness)).taskId,
      adoptSession: adoptSharedSession,
      dropSession: dropSharedSession,
      peekSession: peekSharedSession,
      isTaskReachable: (taskId) => agents.task(taskId).isReachable(),

      dispatchPrompt: ({ taskId, text, workspacePath: path, target }) => ({
        turnId: agents
          .task(taskId)
          .promptFromWidget(text, target, mentionContextParts(path, text))
          .turnId,
      }),
      cancelTask: (taskId) => void cancelAgentTask(taskId),
      cancelTurnAndForget: (taskId) => cancelAgentTurnAndForget(taskId),
      removeQueuedPrompt,
      getTurnStatus: (turnId) => agentTurnsCollection.get(turnId)?.status,
      ensureRuntime: ensureAgentRuntime,

      useRound,
      useSessionList,
      useDefaultHarness: () => ({
        id: defaultHarness.id,
        label: defaultHarness.label,
      }),
      useTrust: (path) => {
        const key = `trust:${workspaceKey(path)}`;
        return {
          isTrusted: Boolean(kv.get(key)),
          grant: () => kv.set(key, true),
        };
      },

      isWorkspaceFile,
      searchWorkspaceFiles,
      toRelativePath: relativeTreePath,

      openFile: (path) =>
        void openFile({ tabId: path, intent: "new-tab" as const }),
      openAgentTab,
      focusDocument: (documentPath, options) =>
        void requestTabFocus(documentPath, {
          reason: options.reason,
          steal: options.steal,
          caret:
            options.caretBeforeNode === undefined
              ? undefined
              : { type: "before-node", pos: options.caretBeforeNode },
        }),
      suppressAmbientFocus: () => suppressTabFocus(),

      slots,
    }),
    [defaultHarness, kv, openFile, openAgentTab],
  );
}
