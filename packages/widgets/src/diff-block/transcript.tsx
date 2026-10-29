/**
 * An agent's file edits in its chat transcript, drawn as the diff blocks
 * they are: each changed file of a tool call as its card (./card.tsx),
 * through the same element a diff fence in a reply is, closed until opened:
 * a record of what was done, not the message. The chat only calls
 * `renderDiffToolCall`; it never learns which tools edit files.
 */
import { createElement, type ReactElement } from "react";
import type { ToolCallContent, ToolCallUpdate } from "@notefig/shared/agent";
import { patchOf } from "./patch";
import { COLLAPSED_ATTRIBUTE, DIFF_BLOCK_TAG, DIFF_DATA_ATTRIBUTE } from "./syntax";

type DiffContent = Extract<ToolCallContent, { type: "diff" }>;

/**
 * The cards for a tool call's file edits, or null to leave the call to the
 * chat's generic line: it edits nothing, or failed (its error is the news).
 * A plain function, not a component — the chat calls it while rendering an
 * entry, so it stays pure and cheap.
 */
export function renderDiffToolCall(call: ToolCallUpdate): ReactElement | null {
  if (call.status === "failed") return null;
  const diffs = (call.content ?? []).filter((item): item is DiffContent => item.type === "diff");
  if (!diffs.length) return null;
  return (
    <div className="flex w-full flex-col">
      {diffs.map((diff, index) => {
        const line = call.locations?.find((location) => location.path === diff.path)?.line ?? 1;
        const patch = patchOf(diff.path, diff.oldText ?? null, diff.newText, line);
        // Keyed by the patch: an edit that streams in draws afresh.
        return createElement(
          DIFF_BLOCK_TAG,
          { key: `${index}:${patch}`, [COLLAPSED_ATTRIBUTE]: "" },
          <pre>
            <code {...{ [DIFF_DATA_ATTRIBUTE]: "" }}>{patch}</code>
          </pre>,
        );
      })}
    </div>
  );
}
