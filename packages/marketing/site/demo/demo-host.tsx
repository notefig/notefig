import type { ReactNode } from "react";
import {
  PromptWidgetHostProvider,
  type PromptRound,
  type PromptWidgetHost,
} from "@notefig/widgets";
import { FileTypeIcon } from "@/components/editor/file-type-icon";
import { Markdown } from "@/components/ui/markdown";
import { DEMO_FILES } from "./demo-fixtures";

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
  // The composer's own "@" menu mounts in a floating layer outside the
  // scaled demo, so it would render at full app size beside the card. The
  // scripted demos draw the same SuggestionList inside the card instead
  // (demo-prompt.tsx), and the live menu stays closed: no search results.
  // Chips still resolve — isWorkspaceFile above knows the files.
  searchWorkspaceFiles: () => [],
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

/** The same host with another default agent: one per harness, built once,
 *  so the widgets under it show that agent as theirs. */
const hostsByHarness = new Map(
  HARNESSES.map((harness) => [
    harness.id,
    { ...demoHost, useDefaultHarness: () => harness },
  ]),
);

/** Scope a widget to one agent — two widgets in one document, two agents. */
export function AgentHost({
  harnessId,
  children,
}: {
  harnessId: string;
  children: ReactNode;
}) {
  return (
    <PromptWidgetHostProvider host={hostsByHarness.get(harnessId) ?? demoHost}>
      {children}
    </PromptWidgetHostProvider>
  );
}
