/**
 * The widget's phase → face mapping. PromptBlobFace is the branchiest part
 * of the widget and, until it was split out of PromptBlob, the part no test
 * could reach: every hook, subscription and side effect now lives in the
 * container, so the face renders from plain objects.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

// react-i18next resolves the hoisted root React copy under vitest (hooks
// break across instances); the face only uses it for labels, so stub it.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: "3rdParty" as const, init: () => {} },
}));

// The composer is a full Tiptap editor; the face's contract with it is
// "rendered in the composing phase", not its internals. The only module mock
// left in this file — everything the face needs from the application now
// arrives through the host object below.
vi.mock("../composer/prompt-editor", () => ({
  PromptEditor: () => createElement("div", { "data-testid": "composer" }),
}));

import { PromptBlobFace } from "../ui/prompt-blob";
import type { BlobPhase } from "../state";
import type { AgentTaskRow, AgentTurn } from "@notefig/shared/agent";
import { fakePromptWidgetHost, withHost } from "../../testing/fake-host";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;
const noop = () => {};

const record = {
  draft: "draft text",
  boundTurnId: "trn_1",
  boundTaskId: "task_1",
  lastSentPrompt: "the sent prompt",
};

const actions = {
  setDraft: noop,
  send: noop,
  sendFollowUp: noop,
  editPrompt: noop,
  retry: noop,
  stop: noop,
  dismiss: noop,
  revertToSlash: noop,
  backspaceDismiss: noop,
  escapeToEditor: noop,
  rebindSession: noop,
  openBoundChat: noop,
  openFile: noop,
  openAgentTab: noop,
};

function render(
  phase: BlobPhase,
  overrides: {
    display?: Partial<{
      touchedFiles: string[];
      widgetResponse: { kind: "answer" | "issue"; markdown: string } | null;
      activeToolLine: string | null;
      assistantTeaser: string | null;
      queueAhead: number;
    }>;
    turn?: Partial<AgentTurn>;
    task?: Partial<AgentTaskRow>;
  } = {},
): string {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root!.render(
      withHost(
        fakePromptWidgetHost(),
        createElement(PromptBlobFace, {
          phase,
          record,
          turn: overrides.turn as AgentTurn | undefined,
          task: overrides.task as AgentTaskRow | undefined,
          boundTaskId: "task_1",
          workspacePath: "/ws",
          trustName: "Claude Code",
          confirmTrust: false,
          isSending: false,
          display: {
            touchedFiles: [],
            widgetResponse: null,
            activeToolLine: null,
            assistantTeaser: null,
            queueAhead: 0,
            ...overrides.display,
          },
          actions,
          composerRef: { current: null },
        }),
      ),
    ),
  );
  return container.textContent ?? "";
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

describe("PromptBlobFace", () => {
  it("shows the composer while composing", () => {
    render("composing");
    expect(container?.querySelector('[data-testid="composer"]')).not.toBeNull();
  });

  it("shows the sent prompt, not the draft, once sent", () => {
    // The draft is cleared on send in the store, but the face must read the
    // sent prompt for every bound phase — showing a stale draft here was the
    // shape of an earlier bug.
    expect(render("queued")).toContain("the sent prompt");
    expect(render("running")).toContain("the sent prompt");
  });

  it("counts the queue only when something is ahead", () => {
    expect(render("queued")).toContain("promptBlobQueued");
    expect(render("queued", { display: { queueAhead: 2 } })).toContain(
      "promptBlobQueuedAhead",
    );
  });

  it("surfaces the live tool line while running", () => {
    expect(
      render("running", { display: { activeToolLine: "Reading foo" } }),
    ).toContain("Reading foo");
  });

  it("renders the permission card only in needs-permission", () => {
    expect(render("running")).not.toContain("agentAllow");
    // The permission card renders its own content from the request rows;
    // what matters here is that the running face alone doesn't summon it.
    expect(render("needs-permission")).toContain("the sent prompt");
  });

  it("asks for sign-in only when a task row backs it", () => {
    // needs-auth without a task row must render nothing rather than crash:
    // the row is what AuthCard reads.
    expect(render("needs-auth")).toBe("");
    expect(render("needs-auth", { task: { taskId: "task_1" } })).toContain(
      "agentSignInRequired",
    );
  });

  it("shows the agent's answer when done", () => {
    expect(
      render("done", {
        display: {
          widgetResponse: { kind: "answer", markdown: "All set" },
        },
      }),
    ).toContain("All set");
  });

  it("falls back to the assistant teaser when the turn had no answer", () => {
    expect(
      render("done", { display: { assistantTeaser: "wrote three files" } }),
    ).toContain("wrote three files");
  });

  it("shows the failure reason on error", () => {
    expect(render("error", { turn: { error: "boom" } })).toContain("boom");
  });
});
