import { describe, expect, it } from "vitest";
import { takeoverProgress } from "../use-app-takeover";

const VIEWPORT = 1000;
const RUNWAY = 1900; // RUNWAY_VH at a 1000px viewport

describe("takeoverProgress", () => {
  it("is 0 while the runway has not reached the top of the viewport", () => {
    expect(takeoverProgress(1200, RUNWAY, VIEWPORT)).toBe(0);
    expect(takeoverProgress(0, RUNWAY, VIEWPORT)).toBe(0);
  });

  it("tracks the scroll through the pinned stretch", () => {
    // 900px of travel (runway minus one viewport) covers 0 → 1.
    expect(takeoverProgress(-450, RUNWAY, VIEWPORT)).toBe(0.5);
  });

  it("is 1 once the runway is scrolled through, and stays there", () => {
    expect(takeoverProgress(-900, RUNWAY, VIEWPORT)).toBe(1);
    expect(takeoverProgress(-5000, RUNWAY, VIEWPORT)).toBe(1);
  });

  it("hands the viewport over when the runway cannot pin at all", () => {
    // Short viewports/tall chrome: never leave the app half-transitioned.
    expect(takeoverProgress(0, 600, VIEWPORT)).toBe(1);
  });
});
