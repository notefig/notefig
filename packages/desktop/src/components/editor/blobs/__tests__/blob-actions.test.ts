import { describe, it, expect, vi, afterEach } from "vitest";
import { createMarkdownCodec } from "../../markdown-codec";
import { getOrCreateEditor, disposeEditor } from "../../editor-store";

const readWorkspaceTextFile = vi.fn();
const writeWorkspaceTextFile = vi.fn();
vi.mock("@/utils/file-sync", () => ({
  readWorkspaceTextFile: (...args: unknown[]) => readWorkspaceTextFile(...args),
  writeWorkspaceTextFile: (...args: unknown[]) => writeWorkspaceTextFile(...args),
}));

const findBlobAuthorTask = vi.fn();
vi.mock("@/agent/agent-service", () => ({
  findBlobAuthorTask: (...args: unknown[]) => findBlobAuthorTask(...args),
}));

const taskPrompt = vi.fn();
vi.mock("@/agent/agents", () => ({
  agents: {
    task: (taskId: string) => ({
      prompt: (text: string) => {
        taskPrompt(taskId, text);
        // Real handles are infallible: answerBlob watches `completed` to
        // surface orphaned answers (MET-54).
        return {
          turnId: "trn_test",
          completed: Promise.resolve({ status: "completed" }),
        };
      },
    }),
  },
}));

const { answerBlob } = await import("../blob-actions");

const codec = createMarkdownCodec();

const baseMarkdown = [
  "# Doc",
  "",
  "```notefig:question",
  "id: q_test1",
  "status: pending",
  "prompt: Which tier?",
  "```",
  "",
  "After.",
].join("\n");

afterEach(() => {
  vi.clearAllMocks();
  disposeEditor("/ws/notes.md");
});

describe("answerBlob", () => {
  it("answer-while-open: reads the live editor and writes through the adopting primitive", async () => {
    const content = codec.parse(baseMarkdown);
    getOrCreateEditor("/ws/notes.md", { type: "markdown", content, basePath: "/ws" });
    findBlobAuthorTask.mockReturnValue(undefined);

    const result = await answerBlob("/ws/notes.md", "q_test1", { status: "answered", answer: "Pro" });

    expect(result).toEqual({ ok: true });
    expect(writeWorkspaceTextFile).toHaveBeenCalledTimes(1);
    const [writtenPath, writtenContent] = writeWorkspaceTextFile.mock.calls[0];
    expect(writtenPath).toBe("/ws/notes.md");
    expect(writtenContent).toContain("status: answered");
    expect(writtenContent).toContain("answer: Pro");
    expect(readWorkspaceTextFile).not.toHaveBeenCalled();
    // Live-editor adoption is writeWorkspaceTextFile's job now — covered by
    // file-sync-workspace-fs.test.ts against an open editor.
  });

  it("answer-while-closed: falls back to readWorkspaceTextFile/writeWorkspaceTextFile", async () => {
    readWorkspaceTextFile.mockResolvedValue(baseMarkdown);
    findBlobAuthorTask.mockReturnValue(undefined);

    const result = await answerBlob("/ws/closed.md", "q_test1", { status: "answered", answer: "Free" });

    expect(result).toEqual({ ok: true });
    expect(readWorkspaceTextFile).toHaveBeenCalledWith("/ws/closed.md");
    expect(writeWorkspaceTextFile).toHaveBeenCalledTimes(1);
    expect(writeWorkspaceTextFile.mock.calls[0][1]).toContain("answer: Free");
  });

  it("agent-deleted: returns not_found when the blob id is no longer present", async () => {
    readWorkspaceTextFile.mockResolvedValue("# Doc\n\nno blobs here\n");

    const result = await answerBlob("/ws/gone.md", "q_missing", { status: "answered" });

    expect(result).toEqual({ ok: false, reason: "not_found" });
    expect(writeWorkspaceTextFile).not.toHaveBeenCalled();
  });

  it("concurrent rewrite: returns conflict when the resulting patch fails envelope validation", async () => {
    // patchBlobInMarkdown has no separate stale-read detection — it is
    // always ID-addressed against whatever was just read — so the race
    // window answerBlob guards against is exactly this: applying a patch
    // whose result the envelope schema rejects (e.g. built from an
    // envelope shape a concurrent writer has since changed). Both this
    // "invalid_patch" case and a genuinely stale block map to the same
    // "conflict" reason in answerBlob (see blob-actions.ts).
    readWorkspaceTextFile.mockResolvedValue(baseMarkdown);

    const result = await answerBlob("/ws/race.md", "q_test1", {
      status: "not-a-real-status",
    });

    expect(result).toEqual({ ok: false, reason: "conflict" });
    expect(writeWorkspaceTextFile).not.toHaveBeenCalled();
  });

  it("prompts the authoring task with the type's directive formatter on success", async () => {
    readWorkspaceTextFile.mockResolvedValue(baseMarkdown);
    findBlobAuthorTask.mockReturnValue({ taskId: "t_1", blobType: "question", path: "/ws/closed.md" });

    await answerBlob("/ws/closed.md", "q_test1", { status: "answered", answer: "Enterprise" });

    expect(taskPrompt).toHaveBeenCalledTimes(1);
    const [taskId, text] = taskPrompt.mock.calls[0];
    expect(taskId).toBe("t_1");
    expect(text).toContain("Enterprise");
    expect(text).toContain("q_test1");
    expect(text).toContain("/ws/closed.md");
    // Directive, not just informational: instructs the agent to replace the
    // answered block with the content the answer resolves to.
    expect(text.toLowerCase()).toContain("replace");
  });

  it("falls back to the generic informational sentence for a type without a formatter", async () => {
    readWorkspaceTextFile.mockResolvedValue(baseMarkdown);
    findBlobAuthorTask.mockReturnValue({ taskId: "t_1", blobType: "status", path: "/ws/closed.md" });

    await answerBlob("/ws/closed.md", "q_test1", { status: "answered", answer: "done" });

    const [, text] = taskPrompt.mock.calls[0];
    expect(text).toContain('the "status" block');
    expect(text).toContain("q_test1");
    expect(text).toContain("done");
    expect(text.toLowerCase()).not.toContain("replace");
  });

  it("does not prompt any task when the patch fails", async () => {
    readWorkspaceTextFile.mockResolvedValue("# Doc\n\nno blobs here\n");

    await answerBlob("/ws/gone.md", "q_missing", { status: "answered" });

    expect(taskPrompt).not.toHaveBeenCalled();
    expect(findBlobAuthorTask).not.toHaveBeenCalled();
  });
});

describe("formatAnswerPrompt (per-type, single-file protocol)", () => {
  const envelope = { id: "q_test1", status: "pending", createdBy: "agent" } as const;

  it("question: states the answer and directs the agent to replace the block", async () => {
    const questionType = (await import("../question.blob")).default;
    const text = questionType.formatAnswerPrompt!({
      blobId: "q_test1",
      path: "/ws/notes.md",
      envelope: { ...envelope, prompt: "Which tier?" },
      patch: { answer: "Pro", status: "answered" },
    });
    expect(text).toContain("Pro");
    expect(text).toContain("q_test1");
    expect(text).toContain("/ws/notes.md");
    expect(text).toContain("Which tier?");
    expect(text.toLowerCase()).toContain("replace");
  });

  it("approval: approved directs proceed-then-replace; rejected directs do-not-proceed", async () => {
    const approvalType = (await import("../approval.blob")).default;
    const approved = approvalType.formatAnswerPrompt!({
      blobId: "a_test1",
      path: "/ws/notes.md",
      envelope: { ...envelope, id: "a_test1", prompt: "Delete the intro?" },
      patch: { decision: "approved", status: "answered" },
    });
    expect(approved).toContain("approved");
    expect(approved).toContain("a_test1");
    expect(approved).toContain("/ws/notes.md");
    expect(approved.toLowerCase()).toContain("replace");
    expect(approved).toContain("Proceed");

    const rejected = approvalType.formatAnswerPrompt!({
      blobId: "a_test1",
      path: "/ws/notes.md",
      envelope: { ...envelope, id: "a_test1" },
      patch: { decision: "rejected", status: "answered" },
    });
    expect(rejected).toContain("rejected");
    expect(rejected).toContain("Do not proceed");
  });

  it("status: has no formatter (falls back to the generic sentence)", async () => {
    const statusType = (await import("../status.blob")).default;
    expect(statusType.formatAnswerPrompt).toBeUndefined();
  });
});
