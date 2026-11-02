import { describe, it, expect } from "vitest";
import {
  parseProcessMarker,
  parseProcessMarkerData,
  serializeProcessMarker,
  stripProcessMarkers,
} from "../marker-codec";

describe("process marker", () => {
  it("round-trips a block", () => {
    const marker = { blobId: "blob_1a2b", command: "npm run dev" };
    const text = serializeProcessMarker(marker);
    expect(text).toBe('<!-- notefig:process id="blob_1a2b" command="npm run dev" -->');
    expect(parseProcessMarker(text!)).toEqual(marker);
  });

  it("escapes a command that would end the attribute, the comment or the line", () => {
    const command = 'echo "a && b" --> x --!> y\nnext';
    const text = serializeProcessMarker({ blobId: "blob_1", command })!;
    expect(text).not.toMatch(/-->.*-->/);
    expect(text).not.toContain("\n");
    expect(text.match(/"/g)).toHaveLength(4);
    expect(parseProcessMarker(text)).toEqual({ blobId: "blob_1", command });
  });

  it("writes nothing without an id or a command", () => {
    expect(serializeProcessMarker({ blobId: "blob_1" })).toBeNull();
    expect(serializeProcessMarker({ command: "ls" })).toBeNull();
    expect(serializeProcessMarker({ blobId: 'x" -->', command: "ls" })).toBeNull();
  });

  it("ignores comments that are not ours", () => {
    expect(parseProcessMarker("<!-- just a note -->")).toBeNull();
    expect(
      parseProcessMarker('<!-- notefig:prompt id="blob_1" task="task_1" -->'),
    ).toBeNull();
    expect(parseProcessMarker('<!-- notefig:process id="blob_1" command="" -->')).toBeNull();
  });

  it("parses a DOM comment node's data", () => {
    expect(parseProcessMarkerData(' notefig:process id="blob_1" command="ls -la" ')).toEqual({
      blobId: "blob_1",
      command: "ls -la",
    });
  });

  it("strips markers out of a file", () => {
    const only = '<!-- notefig:process id="blob_1" command="ls" -->\n';
    expect(stripProcessMarkers(only).trim()).toBe("");
  });
});
