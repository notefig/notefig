import { describe, it, expect } from "vitest";
import { searchStream } from "../browser-fs-adapter";

/**
 * Helper to create a ReadableStream from a string, optionally split
 * into chunks of a given size to test chunk-boundary handling.
 */
function stringToStream(
  text: string,
  chunkSize?: number,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);

  if (!chunkSize) {
    return new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
  }

  return new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunkSize) {
        controller.enqueue(bytes.slice(i, i + chunkSize));
      }
      controller.close();
    },
  });
}

describe("searchStream", () => {
  it("finds a simple match on a single line", async () => {
    const stream = stringToStream("hello world\n");
    const results = await searchStream(stream, "/test.txt", /hello/g);
    expect(results).toHaveLength(1);
    expect(results[0].filePath).toBe("/test.txt");
    expect(results[0].matchText).toBe("hello");
    expect(results[0].lineText).toBe("hello world");
    expect(results[0].occurrence).toBe(0);
  });

  it("finds multiple matches on the same line", async () => {
    const stream = stringToStream("aaa bbb aaa\n");
    const results = await searchStream(stream, "/f.txt", /aaa/g);
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.occurrence)).toEqual([0, 1]);
  });

  it("finds matches across multiple lines", async () => {
    const stream = stringToStream("line one\nline two\nline three\n");
    const results = await searchStream(stream, "/f.txt", /line/g);
    expect(results).toHaveLength(3);
    expect(results.map((r) => r.lineText)).toEqual([
      "line one",
      "line two",
      "line three",
    ]);
    expect(results.map((r) => r.occurrence)).toEqual([0, 1, 2]);
  });

  it("handles file without trailing newline", async () => {
    const stream = stringToStream("no trailing newline");
    const results = await searchStream(stream, "/f.txt", /trailing/g);
    expect(results).toHaveLength(1);
    expect(results[0].lineText).toBe("no trailing newline");
  });

  it("handles chunk boundaries splitting a line", async () => {
    const stream = stringToStream("hello world\nfoo bar\n", 5);
    const results = await searchStream(stream, "/f.txt", /world/g);
    expect(results).toHaveLength(1);
    expect(results[0].matchText).toBe("world");
    expect(results[0].lineText).toBe("hello world");
  });

  it("handles chunk boundaries splitting a match", async () => {
    const stream = stringToStream("hello world\n", 3);
    const results = await searchStream(stream, "/f.txt", /hello/g);
    expect(results).toHaveLength(1);
    expect(results[0].matchText).toBe("hello");
  });

  it("respects maxResults and cancels reader early", async () => {
    const text = Array.from({ length: 100 }, (_, i) => `match line ${i}`).join(
      "\n",
    );
    const stream = stringToStream(text);
    const results = await searchStream(stream, "/f.txt", /match/g, 5);
    expect(results).toHaveLength(5);
    expect(results.map((r) => r.lineText)).toEqual(
      Array.from({ length: 5 }, (_, i) => `match line ${i}`),
    );
  });

  it("returns empty for no matches", async () => {
    const stream = stringToStream("hello world\nfoo bar\n");
    const results = await searchStream(stream, "/f.txt", /xyz/g);
    expect(results).toEqual([]);
  });

  it("handles empty stream", async () => {
    const stream = stringToStream("");
    const results = await searchStream(stream, "/f.txt", /anything/g);
    expect(results).toEqual([]);
  });

  it("handles case-insensitive regex", async () => {
    const stream = stringToStream("Hello HELLO hello\n");
    const results = await searchStream(stream, "/f.txt", /hello/gi);
    expect(results).toHaveLength(3);
    // Distinct cased texts each count their own occurrences.
    expect(results.map((r) => [r.matchText, r.occurrence])).toEqual([
      ["Hello", 0],
      ["HELLO", 0],
      ["hello", 0],
    ]);
  });

  it("handles zero-width matches without infinite loop", async () => {
    const stream = stringToStream("abc\n");
    const results = await searchStream(stream, "/f.txt", /(?=a)/g);
    expect(results).toHaveLength(1);
    expect(results[0].matchText).toBe("");
  });

  it("keeps matches in order across many small chunks", async () => {
    const text = "L1\nL2\nL3\nL4\nL5\n";
    const stream = stringToStream(text, 1);
    const results = await searchStream(stream, "/f.txt", /L\d/g);
    expect(results).toHaveLength(5);
    expect(results.map((r) => r.matchText)).toEqual([
      "L1",
      "L2",
      "L3",
      "L4",
      "L5",
    ]);
  });

  it("handles lines with only newlines (empty lines)", async () => {
    const stream = stringToStream("a\n\n\nb\n");
    const results = await searchStream(stream, "/f.txt", /[ab]/g);
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.matchText)).toEqual(["a", "b"]);
  });
});
