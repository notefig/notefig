/**
 * Pure derivations for the prompt blob's state machine — no React, no
 * collections. The widget feeds these its live-query results; keeping the
 * phase/summary logic here makes the micro-interaction states unit-testable
 * without mounting Tiptap.
 */
import type { ToolCallUpdate } from "@metrists/shared/agent";
import type {
  AgentEntry,
  AgentTaskRow,
  AgentTurn,
} from "@/agent/agent-collections";
import {
  WidgetRespondInputSchema,
  type WidgetResponse,
} from "@/agent/tools/widget-respond";
import { getFileName } from "@/utils/fs";

export type BlobPhase =
  | "composing"
  | "sending"
  | "queued"
  | "running"
  | "needs-permission"
  | "needs-auth"
  | "done"
  | "error";

/**
 * The widget's phase, from its bound turn + task rows. `isSending` covers
 * the window between the send click and the turn row existing (session
 * spawn/handshake); a bound turn whose row is missing is stale (app restart,
 * task disposed) and falls back to composing via the caller's reset.
 */
export function derivePhase({
  turn,
  task,
  hasPendingPermission,
  isSending,
}: {
  turn: AgentTurn | undefined;
  task: AgentTaskRow | undefined;
  hasPendingPermission: boolean;
  isSending: boolean;
}): BlobPhase {
  if (isSending) return "sending";
  if (!turn) return "composing";
  // Auth-block holds the prompt before/between turns — surface it whether
  // the turn is queued (held) or errored out on the auth failure.
  if (task?.authRequired && turn.status !== "completed") return "needs-auth";
  switch (turn.status) {
    case "queued":
      return "queued";
    case "running":
      return hasPendingPermission ? "needs-permission" : "running";
    case "error":
      return "error";
    case "completed":
    case "cancelled":
      return "done";
  }
}

/**
 * The transient status line while running: the latest tool call still in
 * flight, labeled by its title (adapters send human titles; MCP prefixes are
 * stripped upstream) with the primary file basename when one is known.
 */
export function deriveActiveToolLine(entries: AgentEntry[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "tool_call" || !entry.toolCall) continue;
    const status = entry.toolCall.status ?? "pending";
    if (status !== "pending" && status !== "in_progress") continue;
    // Never return "" — an empty label would render as a blank line where
    // the caller's `||` fallback should kick in instead.
    const title = entry.toolCall.title?.trim();
    const path = entry.toolCall.locations?.[0]?.path;
    const file = path ? getFileName(path).trim() : "";
    if (title && file) return `${title} · ${file}`;
    if (title) return title;
    if (file) return file;
    return null;
  }
  return null;
}

/**
 * A one-line teaser of the latest assistant text while running, for the
 * running row's second line when no tool call is currently in flight (see
 * deriveActiveToolLine). Same hygiene: stop at the first match scanning
 * backward, never return "".
 */
export function deriveLatestAssistantLine(
  entries: AgentEntry[],
): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "assistant") continue;
    const text = entry.text?.trim();
    return text ? text : null;
  }
  return null;
}

/**
 * The turn's widget response (MET-92), derived from the transcript rather
 * than stored anywhere: the `widget_respond` tool's `tool_call` entry IS the
 * record (its execute is validate-and-acknowledge; see widget-respond.ts),
 * the same transcript-as-record design `findBlobAuthorTask` uses for blob
 * routing. Backward scan = last-write-wins when the agent calls it twice.
 * Malformed or missing `rawInput` (an adapter that doesn't stream it) is
 * skipped, so the caller falls back to the plain done face — the same
 * degradation as a harness that never calls the tool at all.
 */
export function deriveWidgetResponse(
  entries: AgentEntry[],
): WidgetResponse | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "tool_call") continue;
    if (entry.toolCall?.title !== "widget_respond") continue;
    const parsed = WidgetRespondInputSchema.safeParse(entry.toolCall.rawInput);
    if (parsed.success) return parsed.data;
  }
  return null;
}

/**
 * The card chrome per phase. Done is the widget's resting face — it sits in
 * the document long-term, so it sheds the card shadow and softens to stay
 * out of the prose's way; every other phase keeps the raised look of an
 * active control, with amber/muted washes for the two attention states.
 * (The caller composes this with the invariant "rounded-lg border".)
 */
export function blobCardClass(phase: BlobPhase): string {
  if (phase === "done") return "border-border/60 bg-card/80";
  const raised = "shadow-lg shadow-black/5 dark:shadow-black/40";
  if (phase === "needs-auth") {
    return `${raised} border-amber-500/40 bg-background bg-gradient-to-b from-amber-500/10 to-amber-500/10`;
  }
  if (phase === "needs-permission") {
    return `${raised} border-border bg-background bg-gradient-to-b from-muted/40 to-muted/40`;
  }
  return `${raised} border-border bg-card`;
}

/**
 * The `promptFromWidget` target for a prompt sent from this widget: the
 * workspace-relative document path (a path outside the workspace passes
 * through untouched), the anchor position (node view's live pos, falling
 * back to end-of-doc when the view can't provide one), and the empty-doc
 * flag. Shared by the initial send and the reply path — the file-path
 * slicing lives here once, testable, instead of twice in the component.
 */
export function widgetPromptTarget(params: {
  documentPath: string;
  workspacePath: string;
  pos: number | undefined;
  docContentSize: number;
  isDocEmpty: boolean;
}): { path: string; pos: number; isDocEmpty: boolean } {
  const { documentPath, workspacePath, pos, docContentSize, isDocEmpty } =
    params;
  const path = documentPath.startsWith(workspacePath + "/")
    ? documentPath.slice(workspacePath.length + 1)
    : documentPath;
  return { path, pos: pos ?? docContentSize, isDocEmpty };
}

/**
 * The done face's one-line summary + expandable body. Collapsed, the line
 * is the outcome itself: response title, else the response markdown, else
 * the turn's last assistant text, else the bare Done/Stopped label.
 * Expanded, the line shows only the heading (title or label) so it doesn't
 * echo the body rendered below it. `body` null means there is nothing to
 * expand. Labels arrive resolved (this module stays i18n-free).
 */
export function deriveDoneLine(params: {
  response: WidgetResponse | null;
  fallbackText: string | null;
  cancelled: boolean;
  expanded: boolean;
  labels: { done: string; stopped: string; issue: string };
}): { summary: string; body: string | null; isIssue: boolean } {
  const { response, fallbackText, cancelled, expanded, labels } = params;
  const isIssue = response?.kind === "issue";
  const body = response?.markdown ?? fallbackText;
  const doneLabel = cancelled ? labels.stopped : labels.done;
  const heading = response?.title ?? (isIssue ? labels.issue : doneLabel);
  const summary = expanded ? heading : (response?.title ?? body ?? doneLabel);
  return { summary, body, isIssue };
}

/** Kinds that mean "this call changed a document". */
const MUTATING_KINDS = new Set(["edit", "delete", "move"]);

function isMutatingCall(call: ToolCallUpdate): boolean {
  if (call.kind && MUTATING_KINDS.has(call.kind)) return true;
  return (call.content ?? []).some((item) => item.type === "diff");
}

/**
 * Documents this turn touched, for the done-state chips. Locations carry
 * workspace-resolved absolute paths (the service synthesizes them from
 * rawInput.path when an adapter omits locations); diff content items are the
 * fallback, resolved against the workspace root when relative.
 */
export function deriveTouchedFiles(
  entries: AgentEntry[],
  workspacePath: string,
): string[] {
  const paths = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== "tool_call" || !entry.toolCall) continue;
    if (!isMutatingCall(entry.toolCall)) continue;
    const locations = entry.toolCall.locations ?? [];
    for (const location of locations) paths.add(location.path);
    if (locations.length === 0) {
      for (const item of entry.toolCall.content ?? []) {
        if (item.type !== "diff") continue;
        paths.add(
          item.path.startsWith("/")
            ? item.path
            : `${workspacePath.replace(/\/$/, "")}/${item.path}`,
        );
      }
    }
  }
  return [...paths];
}

/**
 * The composer's keydown decision, pure so it's testable without mounting
 * the textarea. Enter (no Shift) always submits — send() itself no-ops on
 * an empty/sending draft, so this never needs to know draft state to decide
 * "send". Escape and "/" only special-case to "revert" (turn back into a
 * literal "/") when the draft is empty and the widget is summoned; a
 * non-empty draft on Escape falls back to "escape" (return focus to the doc,
 * draft kept). Backspace on an empty, summoned composer dismisses the
 * widget entirely (no literal "/" left behind) — `canRevert` doubles as the
 * "summoned instances only" guard for both, since it's already exactly
 * that condition (see revertToSlash in prompt-blob.tsx).
 */
export type ComposerKeyAction =
  | { type: "send" }
  | { type: "revert" }
  | { type: "backspaceDismiss" }
  | { type: "escape" }
  | { type: "none" };

export function deriveComposerKeyAction(params: {
  key: string;
  shiftKey: boolean;
  draftEmpty: boolean;
  canRevert: boolean;
}): ComposerKeyAction {
  const { key, shiftKey, draftEmpty, canRevert } = params;
  if (key === "Enter" && !shiftKey) return { type: "send" };
  if (key === "Escape") {
    return draftEmpty && canRevert ? { type: "revert" } : { type: "escape" };
  }
  // The "//" path: a second "/" right after summoning means the user
  // wanted a literal slash.
  if (key === "/" && draftEmpty && canRevert) return { type: "revert" };
  if (key === "Backspace" && draftEmpty && canRevert) {
    return { type: "backspaceDismiss" };
  }
  return { type: "none" };
}

/** How many queued turns run before mine (turn ids are ascending). */
export function deriveQueuePosition(
  taskTurns: AgentTurn[],
  myTurnId: string,
): number {
  return taskTurns.filter(
    (turn) => turn.status === "queued" && turn.turnId < myTurnId,
  ).length;
}
