/**
 * A prompt-widget host with nothing behind it.
 *
 * This file is the extraction's own acceptance test: the widget's suite used
 * to mock the agent facade, the session store, the platform adapter and the
 * TanStack collections module by module. If the contract in ../prompt/host.ts
 * is really the whole seam, standing the widget up should take one object and
 * no `vi.mock` calls at all — so if you find yourself adding a mock next to
 * this helper, the leak it patches over belongs in the contract instead.
 *
 * Exported as `@notefig/widgets/testing` because the host application needs
 * it too: anything of its own that renders below the widget (the agent chat
 * tab shares the composer) has to stand up a host to be testable at all.
 *
 * Every method is a `vi.fn()` so a test can assert on it or re-point it;
 * defaults are the boring answers (no sessions, no files, nothing reachable
 * that the test didn't say was reachable).
 */
import { vi } from "vitest";
import type { ReactNode } from "react";
import type { PromptRound, PromptWidgetHost } from "../prompt/host";
import { PromptWidgetHostProvider } from "../prompt/host-context";

export const EMPTY_ROUND: PromptRound = {
  turn: undefined,
  task: undefined,
  entries: [],
  taskTurns: [],
  pendingPermissions: [],
};

export type FakePromptWidgetHost = {
  [K in keyof PromptWidgetHost]: PromptWidgetHost[K];
};

export function fakePromptWidgetHost(
  overrides: Partial<PromptWidgetHost> = {},
): PromptWidgetHost {
  return {
    startOrGetSharedSession: vi.fn(async () => "task_shared"),
    adoptSession: vi.fn(),
    dropSession: vi.fn(),
    peekSession: vi.fn(() => null),
    isTaskReachable: vi.fn(async () => true),

    dispatchPrompt: vi.fn(() => ({ turnId: "trn_fake" })),
    cancelTask: vi.fn(),
    cancelTurnAndForget: vi.fn(async () => true),
    removeQueuedPrompt: vi.fn(),
    getTurnStatus: vi.fn(() => undefined),
    ensureRuntime: vi.fn(() => true),

    useRound: vi.fn(() => EMPTY_ROUND),
    useSessionList: vi.fn(() => []),
    useDefaultHarness: vi.fn(() => ({ id: "claude", label: "Claude Code" })),
    useHarnessList: vi.fn(() => [
      { id: "claude", label: "Claude Code" },
      { id: "opencode", label: "opencode" },
    ]),
    useTrust: vi.fn(() => ({ isTrusted: true, grant: vi.fn() })),

    isWorkspaceFile: vi.fn(() => false),
    searchWorkspaceFiles: vi.fn(() => []),
    // Posix slicing is enough for tests; the real host owns the platform's
    // path flavor.
    toRelativePath: vi.fn((root: string, absolute: string) =>
      absolute.startsWith(`${root}/`)
        ? absolute.slice(root.length + 1)
        : undefined,
    ),

    openFile: vi.fn(),
    openAgentTab: vi.fn(),
    focusDocument: vi.fn(),

    slots: {
      Markdown: ({ text, className }) => (
        <div data-testid="markdown" className={className}>
          {text}
        </div>
      ),
      PermissionCard: ({ taskId }) => (
        <div data-testid="permission-card">{taskId}</div>
      ),
      AuthCard: ({ task }) => <div data-testid="auth-card">{task.taskId}</div>,
      FileIcon: ({ className }) => (
        <span data-testid="file-icon" className={className} />
      ),
    },

    ...overrides,
  };
}

/** Render helper: the widget under a host, which is all it ever needs. */
export function withHost(host: PromptWidgetHost, children: ReactNode) {
  return (
    <PromptWidgetHostProvider host={host}>{children}</PromptWidgetHostProvider>
  );
}
