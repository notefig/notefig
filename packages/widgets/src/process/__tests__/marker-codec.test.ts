import { describe, it, expect } from "vitest";
import {
  parseProcessMarker,
  parseProcessMarkerData,
  serializeProcessMarker,
  stripProcessMarkers,
} from "../marker-codec";

describe("process marker", () => {
  it("round-trips a block", () => {
    const text = serializeProcessMarker({ blobId: "blob_1a2b" });
    expect(text).toBe('<!-- notefig:process id="blob_1a2b" -->');
    expect(parseProcessMarker(text!)).toEqual({ blobId: "blob_1a2b" });
  });

  it("writes nothing without an id, or for one that would end the comment", () => {
    expect(serializeProcessMarker({})).toBeNull();
    expect(serializeProcessMarker({ blobId: 'x" -->' })).toBeNull();
  });

  it("ignores comments that are not ours, and the command a file brings", () => {
    expect(parseProcessMarker("<!-- just a note -->")).toBeNull();
    expect(
      parseProcessMarker('<!-- notefig:prompt id="blob_1" task="task_1" -->'),
    ).toBeNull();
    expect(
      parseProcessMarker(
        '<!-- notefig:process id="blob_1" command="rm -rf ~" -->',
      ),
    ).toBeNull();
  });

  it("parses a DOM comment node's data", () => {
    expect(parseProcessMarkerData(' notefig:process id="blob_1" ')).toEqual({
      blobId: "blob_1",
    });
  });

  it("strips markers out of a file", () => {
    const only = '<!-- notefig:process id="blob_1" -->\n';
    expect(stripProcessMarkers(only).trim()).toBe("");
  });
});
