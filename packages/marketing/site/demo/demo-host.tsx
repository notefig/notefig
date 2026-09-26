import type { ReactNode } from "react";
import {
  PromptWidgetHostProvider,
  type PromptRound,
  type PromptWidgetHost,
} from "@notefig/widgets";
import { FileTypeIcon } from "@/components/editor/file-type-icon";
import { Markdown } from "@/components/ui/markdown";
import { DEMO_FILES, DEMO_ROOT } from "./demo-fixtures";

/*
 * The fake environment the marketing demos run in: a prompt-widget host with
 * nothing live behind it. The widget package reaches the app only through
 * this one object (widgets/src/prompt/host.ts), so the real widget, composer
 * and transcript render from it unchanged — the same seam the widget's own
 * tests use (widgets/src/testing/fake-host.tsx, which imports vitest and so
 * can't ship). Actions are inert: the demos are scripted, not driven.
 */

const EMPTY_ROUND: PromptRound = {
  turn: undefined,
  task: undefined,
  entries: [],
  taskTurns: [],
  pendingPermissions: [],
};

const HARNESSES = [
  { id: "claude-code", label: "Claude Code" },
  { id: "opencode", label: "OpenCode" },
];

const noop = () => {};

const demoHost: PromptWidgetHost = {
  startOrGetSharedSession: async () => "task_demo",
  adoptSession: noop,
  dropSession: noop,
  peekSession: () => "task_demo",
  isTaskReachable: async () => true,

  dispatchPrompt: () => ({ turnId: "trn_demo" }),
  cancelTask: noop,
  cancelTurnAndForget: async () => true,
  removeQueuedPrompt: noop,
  getTurnStatus: () => undefined,
  ensureRuntime: () => true,

  useRound: () => EMPTY_ROUND,
  useSessionList: () => [],
  useDefaultHarness: () => HARNESSES[0],
  useHarnessList: () => HARNESSES,
  useTrust: () => ({ isTrusted: true, grant: noop }),

  isWorkspaceFile: (_root, relativePath) =>
    DEMO_FILES.includes(relativePath),
  searchWorkspaceFiles: (_root, query, limit) =>
    DEMO_FILES.filter((file) => file.includes(query))
      .slice(0, limit)
      .map((relativePath) => ({
        relativePath,
        title: relativePath.split("/").pop() ?? relativePath,
        path: `${DEMO_ROOT}/${relativePath}`,
      })),
  toRelativePath: (root, absolute) =>
    absolute.startsWith(`${root}/`) ? absolute.slice(root.length + 1) : undefined,

  openFile: noop,
  openAgentTab: noop,
  focusDocument: noop,

  // The app's own renderers: markdown through the conversion worker, file
  // icons from the editor. Permission/auth never come up in the scripts.
  slots: {
    Markdown,
    PermissionCard: () => null,
    AuthCard: () => null,
    FileIcon: FileTypeIcon,
  },
};

export function DemoHost({ children }: { children: ReactNode }) {
  return (
    <PromptWidgetHostProvider host={demoHost}>{children}</PromptWidgetHostProvider>
  );
}
