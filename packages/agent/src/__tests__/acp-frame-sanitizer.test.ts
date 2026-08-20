import { describe, expect, it } from "vitest";
import { sanitizeAcpFrame } from "../agent-transport.interface";

function frame(update: Record<string, unknown>): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId: "sess_1", update },
  });
}

describe("sanitizeAcpFrame", () => {
  it("boxes an array rawOutput so the 0.4.5 schema accepts it", () => {
    const line = frame({
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      status: "completed",
      rawOutput: [{ type: "text", text: "ok" }],
    });
    const parsed = JSON.parse(sanitizeAcpFrame(line));
    expect(parsed.params.update.rawOutput).toEqual({
      output: [{ type: "text", text: "ok" }],
    });
    expect(parsed.params.update.status).toBe("completed");
  });

  it("boxes a string rawOutput", () => {
    const line = frame({
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      status: "failed",
      rawOutput: "boom",
    });
    const parsed = JSON.parse(sanitizeAcpFrame(line));
    expect(parsed.params.update.rawOutput).toEqual({ output: "boom" });
  });

  it("leaves a plain-object rawOutput untouched (byte-identical)", () => {
    const line = frame({
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      status: "completed",
      rawOutput: { exitCode: 0 },
    });
    expect(sanitizeAcpFrame(line)).toBe(line);
  });

  it("leaves frames without rawOutput untouched (fast path)", () => {
    const line = frame({
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      status: "completed",
    });
    expect(sanitizeAcpFrame(line)).toBe(line);
  });

  it("ignores non-session/update methods and unparseable lines", () => {
    const response = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { rawOutput: ["not", "an", "update"] },
    });
    expect(sanitizeAcpFrame(response)).toBe(response);
    expect(sanitizeAcpFrame('not json "rawOutput"')).toBe(
      'not json "rawOutput"',
    );
  });
});
