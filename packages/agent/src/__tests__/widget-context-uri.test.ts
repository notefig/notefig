import { describe, it, expect } from "vitest";
import {
  encodeWidgetContextUri,
  decodeWidgetContextUri,
} from "../widget-context-uri";

describe("encodeWidgetContextUri / decodeWidgetContextUri", () => {
  it("round-trips a path and position", () => {
    const uri = encodeWidgetContextUri({ path: "notes.md", pos: 42 });
    expect(uri.startsWith("notefig://widget-context?")).toBe(true);
    expect(decodeWidgetContextUri(uri)).toEqual({ path: "notes.md", pos: 42 });
  });

  it("round-trips paths with characters that need escaping", () => {
    const uri = encodeWidgetContextUri({
      path: "some folder/a doc.md",
      pos: 7,
    });
    expect(decodeWidgetContextUri(uri)).toEqual({
      path: "some folder/a doc.md",
      pos: 7,
    });
  });

  it("returns undefined for a uri outside the widget-context scheme", () => {
    expect(decodeWidgetContextUri("file:///ws/notes.md")).toBeUndefined();
  });

  it("returns undefined when the path param is missing", () => {
    expect(
      decodeWidgetContextUri("notefig://widget-context?pos=1"),
    ).toBeUndefined();
  });

  it("returns undefined when the pos param is missing", () => {
    expect(
      decodeWidgetContextUri("notefig://widget-context?path=notes.md"),
    ).toBeUndefined();
  });

  it("returns undefined when pos is not a finite number", () => {
    expect(
      decodeWidgetContextUri(
        "notefig://widget-context?path=notes.md&pos=not-a-number",
      ),
    ).toBeUndefined();
  });
});
