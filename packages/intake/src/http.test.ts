import { describe, expect, it } from "vitest";
import { readBody } from "./http";

function streamed(chunks: string[], headers: Record<string, string> = {}): Request {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Request("https://intake.test/", { method: "POST", body, headers, duplex: "half" } as RequestInit);
}

describe("readBody", () => {
  it("reads a body within the limit", async () => {
    expect(await readBody(streamed(["héllo ", "wörld"]), 100)).toBe("héllo wörld");
  });

  it("refuses a declared length over the limit without reading", async () => {
    expect(await readBody(streamed(["x"], { "content-length": "101" }), 100)).toBeUndefined();
  });

  it("stops reading an undeclared body once it passes the limit", async () => {
    expect(await readBody(streamed(["x".repeat(60), "x".repeat(60)]), 100)).toBeUndefined();
  });
});
