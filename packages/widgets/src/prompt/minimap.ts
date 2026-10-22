/**
 * The prompt widget's minimap declaration (MET-172): what its dot says.
 * The generic rail (../minimap) owns how dots look; this module maps the
 * widget's phase onto the two-axis vocabulary and keeps it live.
 *
 * Everything it shows comes from the document's prompt service
 * (./widgets-service.ts): the widget's state and its bound round's rows —
 * the same object the widget's face reads, so the dot can never disagree
 * with the card.
 */
import type { Node as PMNode } from "@tiptap/pm/model";
import type {
  MinimapDotState,
  MinimapObserveHandle,
  MinimapObserver,
  MinimapSource,
} from "../minimap/contract";
import {
  deriveQueuePosition,
  type BlobPhase,
} from "./state";
import { phaseOf } from "./machine";
import type {
  PromptRoundSnapshot,
  PromptWidgetsApi,
} from "./widgets-service";

// ── phase → dot state (the settled two-axis map) ──────────────────────

const QUIET: Omit<MinimapDotState, "core" | "label"> = {
  hollow: false,
  breathe: false,
  pulse: false,
  ping: false,
};

/**
 * Phase → visual treatment. Color only where it means something, motion
 * only for live states: waiting pulses, working breathes, states blocked
 * on a human wave — including a completed turn nobody has looked at.
 */
export function describeDotState(
  phase: BlobPhase,
  {
    unseen,
    queueAhead,
    issue = false,
  }: { unseen: boolean; queueAhead: number; issue?: boolean },
): MinimapDotState {
  switch (phase) {
    case "composing":
      return { ...QUIET, core: "neutral", hollow: true, label: "Draft" };
    case "sending":
      return {
        ...QUIET,
        core: "neutral",
        hollow: true,
        pulse: true,
        label: "Sending…",
      };
    case "queued":
      return {
        ...QUIET,
        core: "neutral",
        hollow: true,
        pulse: true,
        label:
          queueAhead > 0 ? `Queued · ${queueAhead} ahead` : "Queued · next",
      };
    case "running":
      return { ...QUIET, core: "neutral", label: "Running", breathe: true };
    case "needs-permission":
      return {
        ...QUIET,
        core: "attention",
        label: "Needs permission",
        ping: true,
      };
    case "needs-auth":
      return {
        ...QUIET,
        core: "attention",
        label: "Needs sign-in",
        ping: true,
      };
    case "error":
      // Errors demand attention the same way blocked states do.
      return { ...QUIET, core: "error", label: "Failed", ping: true };
    case "done": {
      // An unread result needs attention too — it pulses until the user
      // has actually scrolled the widget into view. A turn that completed
      // but answered with an issue (widget_respond kind "issue", the
      // face's amber warning) holds a problematic result: error core.
      const label = issue ? "Done · issue" : "Done";
      if (unseen) {
        return {
          ...QUIET,
          core: issue ? "error" : "fresh",
          label: `${label} · unread`,
          ping: true,
        };
      }
      // Seen: a clean result decays to a bare dot; an issue keeps its
      // error core as a quiet, motionless marker.
      return { ...QUIET, core: issue ? "error" : "neutral", label };
    }
  }
}

function queuedBehind(
  snapshot: PromptRoundSnapshot | undefined,
  phase: BlobPhase,
  boundTurnId: string | null,
): number {
  if (phase !== "queued" || !boundTurnId || !snapshot) return 0;
  return deriveQueuePosition(snapshot.taskTurns, boundTurnId);
}

/** The dot's inputs, derived from the widget's state and round. Pure —
 *  recompute just applies it and manages the visibility watcher. */
function deriveDotInputs(
  prompts: PromptWidgetsApi,
  blobId: string | null,
): {
  phase: BlobPhase;
  roundKey: string | null;
  unseen: boolean;
  queueAhead: number;
  issue: boolean;
} {
  if (!blobId) {
    return {
      phase: "composing",
      roundKey: null,
      unseen: false,
      queueAhead: 0,
      issue: false,
    };
  }
  const widget = prompts.get(blobId);
  const snapshot = prompts.round(blobId);
  const phase = phaseOf(widget.state);
  const roundKey = widget.boundTurnId ? `${blobId}:${widget.boundTurnId}` : null;
  return {
    phase,
    roundKey,
    unseen: roundKey ? !seenRounds.has(roundKey) : false,
    queueAhead: queuedBehind(snapshot, phase, widget.boundTurnId),
    // A done round whose stored answer flags an issue.
    issue: phase === "done" && widget.outcome?.response?.kind === "issue",
  };
}

// ── the source ────────────────────────────────────────────────────────

/** Finished rounds whose widget the user has scrolled into view. Session-
 *  scoped on purpose: nothing persists, ids never recur. */
const seenRounds = new Set<string>();

function promptEntry(
  prompts: PromptWidgetsApi,
  node: PMNode,
): { id?: string; title: string } | null {
  const blobId = (node.attrs.blobId as string | null) ?? null;
  const draftText = node.firstChild?.textContent.trim() ?? "";
  const title =
    draftText ||
    (blobId ? prompts.get(blobId).lastSentPrompt.trim() : "") ||
    "Prompt";
  return { id: blobId ?? undefined, title };
}

function observePrompt(
  prompts: PromptWidgetsApi,
  handle: MinimapObserveHandle,
  onChange: () => void,
): MinimapObserver {
  const blobId = (handle.getNode()?.attrs.blobId as string | null) ?? null;
  let current = describeDotState("composing", { unseen: false, queueAhead: 0 });
  let intersection: IntersectionObserver | null = null;
  let destroyed = false;

  const stopWatchingVisibility = () => {
    intersection?.disconnect();
    intersection = null;
  };

  const watchVisibility = (roundKey: string) => {
    if (intersection || typeof IntersectionObserver === "undefined") return;
    const element = handle.getElement();
    if (!element) return;
    intersection = new IntersectionObserver(
      (observed) => {
        if (!observed.some((o) => o.isIntersecting)) return;
        seenRounds.add(roundKey);
        stopWatchingVisibility();
        recompute();
      },
      { threshold: 0.35 },
    );
    intersection.observe(element);
  };

  const recompute = () => {
    if (destroyed) return;
    const inputs = deriveDotInputs(prompts, blobId);
    current = describeDotState(inputs.phase, inputs);
    if (inputs.phase === "done" && inputs.unseen && inputs.roundKey) {
      watchVisibility(inputs.roundKey);
    } else {
      stopWatchingVisibility();
    }
    onChange();
  };

  const unsubscribe = blobId ? prompts.subscribe(blobId, recompute) : null;
  recompute();

  return {
    get: () => current,
    destroy() {
      destroyed = true;
      unsubscribe?.();
      stopWatchingVisibility();
    },
  };
}

/** The prompt widget's minimap slot, over the document's prompt service. */
export function promptMinimapSource({
  prompts,
}: {
  prompts: PromptWidgetsApi;
}): MinimapSource {
  return {
    entry: (node) => promptEntry(prompts, node),
    observe: (handle, onChange) => observePrompt(prompts, handle, onChange),
  };
}
