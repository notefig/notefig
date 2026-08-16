import { describe, expect, it } from "vitest";
import {
  formatCheckpointMessage,
  parseCheckpointMessage,
} from "../history-trailers";

describe("history-trailers", () => {
  it("round-trips subject, role, and ids", () => {
    const message = formatCheckpointMessage({
      subject: "Fix the login bug",
      role: "agent",
      taskId: "tsk_1",
      turnId: "trn_2",
    });
    expect(parseCheckpointMessage(message)).toEqual({
      subject: "Fix the login bug",
      role: "agent",
      taskId: "tsk_1",
      turnId: "trn_2",
    });
  });

  it("flattens newlines and caps the subject at 72 chars", () => {
    const message = formatCheckpointMessage({
      subject: `line one\nline two\n${"x".repeat(100)}`,
      role: "user",
    });
    const { subject } = parseCheckpointMessage(message);
    expect(subject).not.toContain("\n");
    expect(subject.length).toBeLessThanOrEqual(72);
    expect(subject.endsWith("…")).toBe(true);
  });

  it("tolerates pre-trailer commits: subject only, defaults to agent", () => {
    expect(parseCheckpointMessage("old style prompt message\n")).toEqual({
      subject: "old style prompt message",
      role: "agent",
    });
  });

  it("ignores trailer-lookalikes with invalid values", () => {
    const fields = parseCheckpointMessage(
      "subject\n\nNotefig-Role: wizard\nNotefig-Task: tsk_9\n",
    );
    expect(fields.role).toBe("agent");
    expect(fields.taskId).toBe("tsk_9");
  });
});
