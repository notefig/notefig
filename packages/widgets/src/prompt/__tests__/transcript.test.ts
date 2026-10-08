import { describe, it, expect } from "vitest";
import type { ToolCallUpdate } from "@notefig/shared/agent";
import { renderPromptToolCall } from "../transcript";

function call(overrides: Partial<ToolCallUpdate>): ToolCallUpdate {
  return { toolCallId: "call_1", title: "widget_respond", ...overrides };
}

const answer = { kind: "answer", markdown: "the answer" };

/** Which tool calls the prompt widget claims in the chat. What the
 *  claimed card looks like is WidgetResponseView's test. */
describe("renderPromptToolCall", () => {
  it("claims a widget_respond call whose input parses", () => {
    expect(renderPromptToolCall(call({ status: "completed", rawInput: answer }))).not.toBeNull();
  });

  it("leaves a call still streaming its input to the transcript", () => {
    expect(renderPromptToolCall(call({ status: "pending", rawInput: { kind: "answer" } }))).toBeNull();
    expect(renderPromptToolCall(call({ status: "pending" }))).toBeNull();
  });

  it("leaves a failed call to the transcript, so its error shows", () => {
    expect(renderPromptToolCall(call({ status: "failed", rawInput: answer }))).toBeNull();
  });

  it("leaves other tools to the transcript", () => {
    expect(renderPromptToolCall(call({ title: "author_blob", rawInput: answer }))).toBeNull();
    expect(renderPromptToolCall(call({ title: undefined, rawInput: answer }))).toBeNull();
  });
});
