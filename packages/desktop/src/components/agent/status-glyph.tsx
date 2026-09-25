import { OrbLoader, type OrbState } from "@notefig/ui/orb-loader";
import { cn } from "@notefig/ui/utils";
import type { AgentTaskRow, AgentTurnStatus } from "@/entities/agents";
import type { StatusMark } from "@/adapters/platform-adapter.interface";
import type { AttentionKind } from "@/entities/attention";

/**
 * The sidebar's rendering of `StatusMark` — one vocabulary for "what state
 * is this agent thing in", wherever a row lists a session, a prompt round
 * or something waiting on the user: the sessions panel, the Everything view
 * and the platform's outside-the-window view all draw from it, so a spinner
 * means the same thing in each. Deliberately quiet — a hairline ring for
 * anything settled, a filled dot for anything asking, a thin orb (the prompt
 * widget's own) for anything moving — so a list of them reads as text, not
 * as an icon strip.
 */
export type StatusGlyphState = StatusMark;

type GlyphSpec =
  | { shape: "orb"; orb: OrbState; tone: string }
  | { shape: "ring" | "dot"; tone: string };

const GLYPHS: Record<StatusGlyphState, GlyphSpec> = {
  // The prompt widget's thinking orb: "connecting" while the harness
  // spawns and shakes hands, "working" once a turn is running.
  starting: { shape: "orb", orb: "connecting", tone: "text-muted-foreground" },
  running: { shape: "orb", orb: "working", tone: "text-foreground" },
  queued: { shape: "ring", tone: "text-warning" },
  idle: { shape: "ring", tone: "text-muted-foreground/70" },
  done: { shape: "ring", tone: "text-muted-foreground/70" },
  cancelled: { shape: "ring", tone: "text-muted-foreground/70" },
  error: { shape: "dot", tone: "text-warning" },
  unavailable: { shape: "dot", tone: "text-warning" },
  auth: { shape: "dot", tone: "text-warning" },
  "attention-bau": { shape: "dot", tone: "text-success" },
  "attention-error": { shape: "dot", tone: "text-warning" },
};

export function StatusGlyph({
  state,
  className,
}: {
  state: StatusGlyphState;
  className?: string;
}) {
  const spec = GLYPHS[state];
  if (spec.shape === "orb") {
    return (
      <span
        aria-hidden="true"
        data-status-glyph={state}
        className={cn(
          "flex size-3 shrink-0 items-center justify-center",
          spec.tone,
          className,
        )}
      >
        <OrbLoader state={spec.orb} size="0.75rem" />
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      data-status-glyph={state}
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        spec.shape === "dot" ? "bg-current" : "border border-current",
        spec.tone,
        className,
      )}
    />
  );
}

const TASK_GLYPH: Record<AgentTaskRow["status"], StatusGlyphState> = {
  starting: "starting",
  running: "running",
  idle: "idle",
  // A restored session is a normal (idle-equivalent) session whose runtime
  // revives on first interaction (MET-54).
  restored: "idle",
  cancelled: "cancelled",
  error: "error",
  unavailable: "unavailable",
};

/** A session's glyph: sign-in blocks everything else, then the status. */
export function taskGlyphState(
  task: Pick<AgentTaskRow, "status" | "authRequired">,
): StatusGlyphState {
  return task.authRequired ? "auth" : TASK_GLYPH[task.status];
}

const TURN_GLYPH: Record<AgentTurnStatus, StatusGlyphState> = {
  running: "running",
  queued: "queued",
  completed: "done",
  cancelled: "cancelled",
  error: "error",
};

export function turnGlyphState(status: AgentTurnStatus): StatusGlyphState {
  return TURN_GLYPH[status];
}

export function attentionGlyphState(kind: AttentionKind): StatusGlyphState {
  return `attention-${kind}`;
}
