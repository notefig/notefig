import { describe, it, expect } from "vitest";
import {
  parsePromptMarker,
  parsePromptMarkerData,
  serializePromptMarker,
  stripPromptMarkers,
} from "../prompt-marker";

describe("prompt marker", () => {
  it("round-trips a bound widget", () => {
    const marker = { blobId: "blob_1a2b", taskId: "task_9f8e" };
    const text = serializePromptMarker(marker);
    expect(text).toBe(
      '<!-- notefig:prompt id="blob_1a2b" task="task_9f8e" -->',
    );
    expect(parsePromptMarker(text!)).toEqual(marker);
  });

  it("writes nothing for an unbound widget", () => {
    // The keeper and freshly summoned widgets stay pure UI.
    expect(serializePromptMarker({ blobId: "blob_1a2b" })).toBeNull();
    expect(serializePromptMarker({ taskId: "task_9f8e" })).toBeNull();
    expect(serializePromptMarker({})).toBeNull();
  });

  it("refuses ids that could break out of the comment", () => {
    expect(
      serializePromptMarker({ blobId: 'x" --><script>', taskId: "task_1" }),
    ).toBeNull();
    expect(
      serializePromptMarker({ blobId: "blob_1", taskId: "a b" }),
    ).toBeNull();
  });

  it("ignores comments that are not ours", () => {
    expect(parsePromptMarker("<!-- just a note -->")).toBeNull();
    expect(parsePromptMarker('<!-- notefig:blob id="x" -->')).toBeNull();
    expect(parsePromptMarker('<!-- notefig:prompt id="blob_1" -->')).toBeNull();
    expect(parsePromptMarker("not a comment at all")).toBeNull();
  });

  it("parses a DOM comment node's data", () => {
    expect(
      parsePromptMarkerData(' notefig:prompt id="blob_1a2b" task="task_9f8e" '),
    ).toEqual({ blobId: "blob_1a2b", taskId: "task_9f8e" });
    expect(parsePromptMarkerData(" unrelated ")).toBeNull();
  });

  it("tolerates surrounding whitespace in the file", () => {
    expect(
      parsePromptMarker('  <!--notefig:prompt id="blob_1" task="task_2"-->  '),
    ).toEqual({ blobId: "blob_1", taskId: "task_2" });
  });
});

describe("stripPromptMarkers", () => {
  it("leaves a document holding only widgets looking empty", () => {
    const only = '<!-- notefig:prompt id="blob_1" task="task_1" -->\n';
    expect(stripPromptMarkers(only).trim()).toBe("");
  });

  it("removes every marker but keeps real content", () => {
    const doc = [
      '<!-- notefig:prompt id="blob_1" task="task_1" -->',
      "",
      "# Real content",
      "",
      '<!-- notefig:prompt id="blob_2" task="task_1" -->',
    ].join("\n");
    expect(stripPromptMarkers(doc).trim()).toBe("# Real content");
  });

  it("leaves other comments alone", () => {
    expect(stripPromptMarkers("<!-- keep me -->").trim()).toBe(
      "<!-- keep me -->",
    );
  });
});
