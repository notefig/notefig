import { describe, it, expect } from "vitest";
import { tangentsOf } from "./usage-line-chart";

/** The cubic's height at `t` between points i and i + 1 (unit spacing). */
function at(values: number[], m: number[], i: number, t: number): number {
  const [p0, p1] = [values[i], values[i + 1]];
  const [c1, c2] = [p0 + m[i] / 3, p1 - m[i + 1] / 3];
  const u = 1 - t;
  return u ** 3 * p0 + 3 * u * u * t * c1 + 3 * u * t * t * c2 + t ** 3 * p1;
}

describe("tangentsOf", () => {
  it("keeps every segment between its two points", () => {
    const values = [0, 0, 120, 5, 5, 300, 0, 40];
    const m = tangentsOf(values);
    for (let i = 0; i < values.length - 1; i++) {
      const [lo, hi] = [Math.min(values[i], values[i + 1]), Math.max(values[i], values[i + 1])];
      for (let t = 0; t <= 1; t += 0.05) {
        const y = at(values, m, i, t);
        expect(y).toBeGreaterThanOrEqual(lo - 1e-9);
        expect(y).toBeLessThanOrEqual(hi + 1e-9);
      }
    }
  });

  it("is flat at a peak, a trough and a plateau", () => {
    const m = tangentsOf([0, 10, 0, 0, 0]);
    expect(m[1]).toBe(0);
    expect(m[2]).toBe(0);
    expect(m[3]).toBe(0);
  });
});
