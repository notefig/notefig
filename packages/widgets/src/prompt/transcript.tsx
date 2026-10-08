/**
 * The prompt widget in an agent chat transcript: its `widget_respond` call
 * reads as the done face's response, in the done face's card, so the answer
 * looks the same in the chat as in the document. The chat only calls
 * `renderPromptToolCall`; it never learns the tool's name or schema.
 */
import type { ReactElement } from "react";
import type { ToolCallUpdate, WidgetResponse } from "@notefig/shared/agent";
import { cn } from "@notefig/ui/utils";
import { blobCardClass, readWidgetResponse } from "./state";
import { WidgetResponseView } from "./ui/widget-response-view";

/**
 * The card for one of the prompt widget's tool calls, or null to leave the
 * call to the chat's generic line: not one of ours, or not completed yet.
 * The card's check mark says "delivered", so a call that is still pending
 * or running — even with its full answer already streamed in — keeps the
 * generic line's in-flight state, and a failed one its error. A plain
 * function, not a component — the chat calls it while rendering an entry,
 * so it stays pure and cheap; the hooks live in the element it returns.
 */
export function renderPromptToolCall(
  call: ToolCallUpdate,
): ReactElement | null {
  if (call.status !== "completed") return null;
  const response = readWidgetResponse(call);
  return response ? <WidgetRespondCard response={response} /> : null;
}

/** Collapsed by default, unlike in the document: in a transcript the answer
 *  is one row among many, and collapsed it also skips the markdown render
 *  for every widget answer in a long session. The heading expands it. */
function WidgetRespondCard({ response }: { response: WidgetResponse }) {
  return (
    <div
      className={cn(
        "w-full rounded-lg border",
        blobCardClass("done", response.kind === "issue"),
      )}
    >
      <WidgetResponseView response={response} defaultExpanded={false} />
    </div>
  );
}
