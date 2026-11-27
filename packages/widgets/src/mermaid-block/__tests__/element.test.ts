import { describe, it, expect, beforeAll } from "vitest";
import MarkdownIt from "markdown-it";
import { drawnMermaidFences } from "../markdown";
import { defineMermaidBlockElement } from "../element";

const md = new MarkdownIt().use(drawnMermaidFences);

/** Rendered as chat renders it. */
function render(markdown: string) {
  const root = document.createElement("div");
  document.body.append(root);
  root.innerHTML = md.render(markdown);
  return root;
}

describe("<notefig-mermaid-block>", () => {
  beforeAll(() => defineMermaidBlockElement());

  it("draws a diagram in place of its source", async () => {
    const root = render("```mermaid\nflowchart LR\n  Draft --> Merged\n```\n");
    await expect.poll(() => root.querySelector("[data-mermaid-diagram] svg")).not.toBeNull();
    expect(root.querySelector<HTMLElement>("notefig-mermaid-block > pre")!.hidden).toBe(true);
    expect(root.querySelector("[data-mermaid-diagram]")!.textContent).toContain("Draft");
    expect(root.querySelector("[data-mermaid-edit]")).toBeNull();
  });

  it("shrinks a wide diagram only so far, then scrolls it", async () => {
    const fan = Array.from({ length: 14 }, (_, i) => `  Root --> C${i}[Child service ${i}]`).join("\n");
    const root = render(`\`\`\`mermaid\nflowchart TD\n${fan}\n\`\`\`\n`);
    await expect.poll(() => root.querySelector<SVGSVGElement>("[data-mermaid-diagram] svg")).not.toBeNull();
    const drawn = root.querySelector<SVGSVGElement>("[data-mermaid-diagram] svg")!;
    const width = Number(drawn.getAttribute("width") ?? drawn.viewBox.baseVal.width);
    expect(parseFloat(drawn.style.minWidth)).toBe(Math.round(width * 0.75));
  });

  it("shows what is wrong with a diagram it can't read, and its source", async () => {
    const root = render("```mermaid\nflowchart LR\n  A --> \n```\n");
    await expect.poll(() => root.querySelector(".pele-error")).not.toBeNull();
    expect(root.querySelector("[data-mermaid-card] pre")!.textContent).toContain("A -->");
  });

  it("gives its source back when it leaves the page", async () => {
    const root = render("```mermaid\nflowchart LR\n  A --> B\n```\n");
    await expect.poll(() => root.querySelector("[data-mermaid-card]")).not.toBeNull();
    const element = root.querySelector("notefig-mermaid-block")!;
    element.remove();
    expect(element.querySelector("[data-mermaid-card]")).toBeNull();
    expect(element.querySelector<HTMLElement>(":scope > pre")!.hidden).toBe(false);
  });
});
