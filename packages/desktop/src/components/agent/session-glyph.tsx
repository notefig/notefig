import { IconSwap } from "@notefig/ui/icon-swap";
import { SessionMarkIcon } from "@notefig/widgets";
import type { AgentTaskRow } from "@/modules/agents/react";
import { StatusGlyph, type StatusGlyphState } from "@/components/agent/status-glyph";

/** States with nothing to say: the row shows whose it is instead. */
const SETTLED: ReadonlySet<StatusGlyphState> = new Set(["idle", "done", "cancelled"]);

/**
 * The one icon a session's or a prompt's sidebar row carries (MET-284): the
 * session's mark while it is settled, the state's glyph while it starts,
 * runs, waits in a queue or asks for the user. A change between the two
 * shrinks one and grows the other (`IconSwap`). A session from before marks
 * keeps its glyph.
 */
export function SessionGlyph({
  state,
  session,
}: {
  state: StatusGlyphState;
  session: Pick<AgentTaskRow, "colorSlot" | "shapeSlot"> | undefined;
}) {
  const showMark = SETTLED.has(state) && session?.colorSlot !== undefined;
  return (
    <IconSwap swapKey={showMark ? "mark" : state}>
      {showMark ? (
        <SessionMarkIcon colorSlot={session.colorSlot} shapeSlot={session.shapeSlot} />
      ) : (
        <StatusGlyph state={state} />
      )}
    </IconSwap>
  );
}
