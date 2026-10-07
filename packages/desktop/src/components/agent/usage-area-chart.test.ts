import { describe, it, expect } from "vitest";
import { curvePeak, stackedCurves } from "./usage-area-chart";

const bars = (...series: number[][]) =>
  series[0].map((_, i) => ({
    key: i,
    axisLabel: "",
    title: "",
    values: series.map((values) => values[i]),
  }));

/** The cubic's height at `t` along segment `i`. */
function at(curve: ReturnType<typeof stackedCurves>[number], i: number, t: number): number {
  const u = 1 - t;
  return (
    u ** 3 * curve.at[i] +
    3 * u * u * t * curve.c1[i] +
    3 * u * t * t * curve.c2[i] +
    t ** 3 * curve.at[i + 1]
  );
}

describe("stackedCurves", () => {
  it("passes through the stacked totals", () => {
    const curves = stackedCurves(bars([1, 2, 3], [4, 0, 1]), 2);
    expect(curves.map((curve) => curve.at)).toEqual([
      [0, 0, 0],
      [1, 2, 3],
      [5, 2, 4],
    ]);
  });

  it("never lets a band cross the one beneath it", () => {
    // Smoothing the running sums let the top boundary dip under the lower one here.
    const curves = stackedCurves(bars([0, 100, 100], [1, 0, 100]), 2);
    for (let i = 0; i < 2; i++) {
      for (let t = 0; t <= 1; t += 0.05) {
        expect(at(curves[1], i, t)).toBeGreaterThanOrEqual(at(curves[0], i, t) - 1e-9);
        expect(at(curves[2], i, t)).toBeGreaterThanOrEqual(at(curves[1], i, t) - 1e-9);
      }
    }
  });

  it("bounds the top curve, which can rise above every point's total", () => {
    const curves = stackedCurves(bars([0, 80, 100, 0], [0, 20, 0, 100]), 2);
    const top = curves[2];
    const peak = curvePeak(top);
    let highest = 0;
    for (let i = 0; i < 3; i++) {
      for (let t = 0; t <= 1; t += 0.01) highest = Math.max(highest, at(top, i, t));
    }
    expect(highest).toBeGreaterThan(100);
    expect(peak).toBeGreaterThanOrEqual(highest - 1e-9);
  });
});
