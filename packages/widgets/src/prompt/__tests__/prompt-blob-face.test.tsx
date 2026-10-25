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

import { PromptBlobFace, type ChoiceDisplay } from "../ui/prompt-blob";
import type { WidgetResponse } from "@notefig/shared/agent";
import type { BlobPhase } from "../state";
import type { AgentTaskRow } from "@notefig/shared/agent";
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

const sendFollowUp = vi.fn();
const pickOption = vi.fn();

const actions = {
  send: noop,
  sendFollowUp,
  pickOption,
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
      widgetResponse: WidgetResponse | null;
      choice: ChoiceDisplay | null;
      summary: string | null;
      errorMessage: string | null;
      activeToolLine: string | null;
      assistantTeaser: string | null;
      queueAhead: number;
    }>;
    task?: Partial<AgentTaskRow>;
    draft?: string;
    reference?: { text: string; from: number; to: number } | null;
    clearReference?: () => void;
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
          task: overrides.task as AgentTaskRow | undefined,
          boundTaskId: "task_1",
          workspacePath: "/ws",
          trustName: "Claude Code",
          confirmTrust: false,
          isSending: false,
          display: {
            touchedFiles: [],
            widgetResponse: null,
            summary: null,
            cancelled: false,
            errorMessage: null,
            activeToolLine: null,
            assistantTeaser: null,
            queueAhead: 0,
            changeCounts: new Map(),
            changes: {
              count: 0,
              reviewing: false,
              color: "",
              toggleReview: noop,
              showChanges: noop,
              index: null,
              step: noop,
            },
            ...overrides.display,
          },
          actions,
          reference: overrides.reference ?? null,
          clearReference: overrides.clearReference,
          documentPath: "/ws/doc.md",
          draft: overrides.draft ?? "",
          draftIO: {
            read: () => overrides.draft ?? "",
            write: noop,
            holdsCaret: () => false,
            focus: noop,
            leave: noop,
          },
          // The draft is document content, so the face is handed a content
          // hole rather than rendering a composer of its own.
          draftSlot: createElement("div", { "data-testid": "composer" }),
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

  it("shows the referenced text's first line in every phase", () => {
    const reference = { text: "first line\nsecond line", from: 2, to: 24 };
    for (const phase of ["composing", "running", "done"] as BlobPhase[]) {
      const text = render(phase, { reference });
      expect(text).toContain("first line");
      expect(text).not.toContain("second line");
      act(() => root?.unmount());
      container?.remove();
    }
  });

  it("the reference chip's remove control calls clearReference", () => {
    const clearReference = vi.fn();
    render("composing", {
      reference: { text: "the passage", from: 2, to: 13 },
      clearReference,
    });
    const button = container?.querySelector(
      'button[aria-label="promptBlobReferenceRemove"]',
    ) as HTMLButtonElement;
    expect(button).toBeTruthy();
    act(() => button.click());
    expect(clearReference).toHaveBeenCalledTimes(1);
  });

  it("offers the remove control only while the next prompt is composable", () => {
    const removeButton = () =>
      container?.querySelector(
        'button[aria-label="promptBlobReferenceRemove"]',
      );
    const reference = { text: "the passage", from: 2, to: 13 };
    // In flight: the quote is a record of what the agent received.
    for (const phase of ["queued", "running"] as BlobPhase[]) {
      render(phase, { reference, clearReference: vi.fn() });
      expect(removeButton()).toBeNull();
      act(() => root?.unmount());
      container?.remove();
    }
    // Settled: the reply composer is live again, so the quote is editable.
    for (const phase of ["composing", "done", "error"] as BlobPhase[]) {
      render(phase, { reference, clearReference: vi.fn() });
      expect(removeButton()).not.toBeNull();
      act(() => root?.unmount());
      container?.remove();
    }
  });

  it("renders no reference line without a captured reference", () => {
    expect(render("composing")).not.toContain("first line");
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

  const question = (
    kind: "single_choice" | "multiple_choice",
    picked: string[] = [],
  ) => ({
    widgetResponse: {
      kind,
      markdown: "Pro or Enterprise?",
      options: ["Pro", "Enterprise"],
    },
    choice: {
      options: ["Pro", "Enterprise"],
      multiple: kind === "multiple_choice",
      picked,
      focused: null,
    },
  });
  const option = (name: string) =>
    container?.querySelector(
      `[data-choice-option="${name}"]`,
    ) as HTMLButtonElement;

  it("the heading's logo is the bound session's harness, even once it left the picker", () => {
    // The fake picker lists no sessions (as for a cancelled one), and its
    // default harness is "claude".
    render("needs-answer", {
      display: question("single_choice"),
      task: { taskId: "task_1", harnessId: "opencode" },
    });
    expect(container?.querySelector('[data-testid="harness-logo-opencode"]')).not.toBeNull();
    expect(container?.querySelector('[data-testid="harness-logo-claude"]')).toBeNull();
  });

  it("a single choice offers a button per option; clicking one picks it", () => {
    pickOption.mockClear();
    const text = render("needs-answer", { display: question("single_choice") });
    expect(text).toContain("Pro or Enterprise?");
    expect(container?.querySelector('[data-choice="single"]')).not.toBeNull();
    act(() => option("Enterprise").click());
    expect(pickOption).toHaveBeenCalledWith("Enterprise");
    // The field stays open for a typed answer instead.
    const draftRow = container?.querySelector("[data-prompt-draft]");
    expect(draftRow?.getAttribute("data-placeholder")).toBe("promptBlobAnswer");
    expect(draftRow?.closest("[hidden]")).toBeNull();
  });

  it("a multiple choice offers checkboxes, and a send arrow once something is picked", () => {
    pickOption.mockClear();
    sendFollowUp.mockClear();
    const send = () =>
      container?.querySelector('button[aria-label="send"]') as HTMLButtonElement | null;
    render("needs-answer", { display: question("multiple_choice") });
    expect(container?.querySelector('[data-choice="multiple"]')).not.toBeNull();
    expect(option("Pro").getAttribute("role")).toBe("checkbox");
    expect(send()).toBeNull();
    act(() => option("Pro").click());
    expect(pickOption).toHaveBeenCalledWith("Pro");
    act(() => root?.unmount());
    container?.remove();

    render("needs-answer", { display: question("multiple_choice", ["Pro"]) });
    expect(option("Pro").getAttribute("data-state")).toBe("checked");
    act(() => send()!.click());
    expect(sendFollowUp).toHaveBeenCalledTimes(1);
  });

  it("a finished round shows no options", () => {
    render("done", { display: question("single_choice") });
    expect(container?.querySelector("[data-choice]")).toBeNull();
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
      render("done", { display: { summary: "wrote three files" } }),
    ).toContain("wrote three files");
  });

  it("shows the failure reason on error", () => {
    expect(render("error", { display: { errorMessage: "boom" } })).toContain("boom");
  });
});
