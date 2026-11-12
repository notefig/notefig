/**
 * Session marks (MET-284): every shape slot draws, in the session's color on
 * a tint of it, and each mark masks under its own ids.
 */
import { afterEach, describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SESSION_SHAPES } from "@notefig/shared/agent";
import { SessionMarkIcon } from "../session-mark";

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

function draw(marks: { colorSlot?: number; shapeSlot?: number }[]): SVGSVGElement[] {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root!.render(
      marks.map((mark, i) =>
        createElement(SessionMarkIcon, {
          key: i,
          colorSlot: mark.colorSlot,
          shapeSlot: mark.shapeSlot,
        }),
      ),
    ),
  );
  return [...container.querySelectorAll("svg")];
}

/** The drawing inside the clipped group: the tint, then the shape. */
const drawn = (svg: SVGSVGElement) => svg.querySelector("g[clip-path]")!.children;

describe("SessionMarkIcon", () => {
  it("draws every shape slot over the tint, in the session's color", () => {
    const svgs = draw(Array.from({ length: SESSION_SHAPES }, (_, shapeSlot) => ({ colorSlot: 3, shapeSlot })));
    for (const svg of svgs) {
      expect(drawn(svg).length).toBeGreaterThan(1);
      expect(svg.innerHTML).toContain("hsl(var(--session-4) / 0.18)");
      expect(svg.innerHTML).toContain("hsl(var(--session-4))");
    }
  });

  it("is a plain neutral tile for a session from before marks", () => {
    const [svg] = draw([{}]);
    expect(drawn(svg)).toHaveLength(1);
    expect(svg.innerHTML).toContain("--muted-foreground");
    expect(svg.getAttribute("data-session-mark")).toBe(":");
  });

  it("gives each mark its own clip and mask ids", () => {
    const svgs = draw([{ colorSlot: 0, shapeSlot: 11 }, { colorSlot: 1, shapeSlot: 11 }]);
    const ids = svgs.flatMap((svg) => [...svg.querySelectorAll("[id]")].map((el) => el.id));
    expect(new Set(ids).size).toBe(ids.length);
  });
});
