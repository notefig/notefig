import fc from "fast-check";
import {
  parseBlobBlock,
  serializeBlobBlock,
  findBlobs,
  patchBlobInMarkdown,
  BlobParseError,
} from "./blob-codec";

describe("parseBlobBlock", () => {
  it("rejects a language tag without the notefig: prefix", () => {
    const result = parseBlobBlock("typescript", "id: q_8f2a\n");
    expect(result).toEqual({
      ok: false,
      error: expect.any(BlobParseError),
    });
    if (!result.ok) expect(result.error.type).toBe("not_a_blob");
  });

  it("rejects invalid YAML", () => {
    const result = parseBlobBlock("notefig:question", "not: [valid: yaml");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe("invalid_yaml");
  });

  it("rejects YAML that doesn't satisfy the envelope schema", () => {
    const result = parseBlobBlock("notefig:question", "id: not-a-valid-id\n");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe("invalid_envelope");
  });

  it("parses a well-formed blob, defaulting status/createdBy", () => {
    const result = parseBlobBlock(
      "notefig:question",
      "id: q_8f2a\nprompt: Which tier?\n",
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.type).toBe("question");
      expect(result.value.envelope).toMatchObject({
        id: "q_8f2a",
        status: "pending",
        createdBy: "agent",
      });
      expect(result.value.payload).toEqual({
        id: "q_8f2a",
        prompt: "Which tier?",
      });
    }
  });
});

describe("findBlobs", () => {
  it("finds every notefig:* fence and skips invalid ones", () => {
    const markdown = [
      "# Doc",
      "",
      "```notefig:question",
      "id: q_8f2a",
      "prompt: Which tier?",
      "```",
      "",
      "```typescript",
      "const x = 1;",
      "```",
      "",
      "```notefig:question",
      "not: [valid: yaml",
      "```",
      "",
      "```notefig:approval",
      "id: ap_1b2c",
      "prompt: Delete it?",
      "```",
    ].join("\n");

    const blobs = findBlobs(markdown);
    expect(blobs).toHaveLength(2);
    expect(blobs[0].blob.envelope.id).toBe("q_8f2a");
    expect(blobs[1].blob.envelope.id).toBe("ap_1b2c");
    // Offsets point at the real fence text.
    expect(markdown.slice(blobs[0].start, blobs[0].start + 3)).toBe("```");
  });

  it("returns nothing for markdown with no blobs", () => {
    expect(findBlobs("# just a doc\n\nno fences here\n")).toEqual([]);
  });
});

describe("serializeBlobBlock", () => {
  it("round-trips a freshly-authored blob through parseBlobBlock", () => {
    const parsed = parseBlobBlock(
      "notefig:question",
      "id: q_zz99\nprompt: Keep this?\n",
    );
    if (!parsed.ok) throw new Error("fixture should parse");
    const fence = serializeBlobBlock(parsed.value);
    expect(fence).toMatch(/^```notefig:question\n/);
    expect(fence.trim().endsWith("```")).toBe(true);

    const bodyMatch = /```notefig:question\n([\s\S]*)\n```/.exec(fence);
    expect(bodyMatch).not.toBeNull();
    const reparsed = parseBlobBlock("notefig:question", bodyMatch![1]);
    expect(reparsed.ok).toBe(true);
    if (reparsed.ok) {
      expect(reparsed.value.envelope.id).toBe("q_zz99");
    }
  });
});

describe("patchBlobInMarkdown", () => {
  const markdown = [
    "# Doc",
    "",
    "Intro paragraph.",
    "",
    "```notefig:question",
    "id: q_8f2a",
    "status: pending",
    "prompt: Which tier?",
    "# agent note, keep me",
    "x-agent-meta: keep-me",
    "```",
    "",
    "After the blob.",
  ].join("\n");

  it("errors when no fence with that blob id exists", () => {
    const result = patchBlobInMarkdown(markdown, "q_missing", { status: "answered" });
    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ type: "not_found", blobId: "q_missing" }),
    });
  });

  it("patches only the target fence, preserving everything outside it", () => {
    const result = patchBlobInMarkdown(markdown, "q_8f2a", {
      status: "answered",
      answer: "Pro",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.startsWith("# Doc\n\nIntro paragraph.\n\n")).toBe(true);
    expect(result.value.endsWith("\nAfter the blob.")).toBe(true);

    const reparsed = findBlobs(result.value);
    expect(reparsed).toHaveLength(1);
    expect(reparsed[0].blob.envelope.status).toBe("answered");
    expect(reparsed[0].blob.payload.answer).toBe("Pro");
    // Untouched keys/comments survive — the whole point of the yaml
    // Document API instead of a load/dump cycle.
    expect(reparsed[0].blob.payload["x-agent-meta"]).toBe("keep-me");
    expect(result.value).toContain("# agent note, keep me");
  });

  it("patches a fence with CRLF line endings, preserving them outside the patch", () => {
    const crlfMarkdown = [
      "# Doc",
      "",
      "Intro paragraph.",
      "",
      "```notefig:question",
      "id: q_crlf1",
      "status: pending",
      "prompt: Which tier?",
      "```",
      "",
      "After the blob.",
    ].join("\r\n");

    const result = patchBlobInMarkdown(crlfMarkdown, "q_crlf1", {
      status: "answered",
      answer: "Pro",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.startsWith("# Doc\r\n\r\nIntro paragraph.\r\n\r\n")).toBe(true);
    expect(result.value.endsWith("\r\nAfter the blob.")).toBe(true);

    const reparsed = findBlobs(result.value);
    expect(reparsed).toHaveLength(1);
    expect(reparsed[0].blob.envelope.status).toBe("answered");
    expect(reparsed[0].blob.payload.answer).toBe("Pro");
  });

  it("[property] patching preserves every byte outside the target fence", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 30 }).filter((s) => !s.includes("```")),
        fc.string({ minLength: 0, maxLength: 30 }).filter((s) => !s.includes("```")),
        fc.string({ minLength: 1, maxLength: 20 }).filter((s) => /^[a-zA-Z0-9 ]*$/.test(s)),
        (before, after, answer) => {
          const doc = `${before}\n\n\`\`\`notefig:question\nid: q_prop1\nstatus: pending\nprompt: test\n\`\`\`\n\n${after}`;
          const result = patchBlobInMarkdown(doc, "q_prop1", { answer });
          expect(result.ok).toBe(true);
          if (!result.ok) return;
          expect(result.value.startsWith(`${before}\n\n`)).toBe(true);
          expect(result.value.endsWith(`\n\n${after}`)).toBe(true);
        },
      ),
      { numRuns: 50 },
    );
  });
});
