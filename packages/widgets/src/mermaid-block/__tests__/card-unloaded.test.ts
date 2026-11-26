import { describe, it, expect, vi } from "vitest";
import MarkdownIt from "markdown-it";
import { drawnMermaidFences } from "../markdown";
import { defineMermaidBlockElement } from "../element";

// Pele's chunk fails to load, as it would offline or after a deploy.
vi.mock("pele/lazy", () => Promise.reject(new Error("Failed to fetch dynamically imported module")));

describe("<notefig-mermaid-block> without Pele", () => {
  it("shows the diagram's source, not a blank card", async () => {
    defineMermaidBlockElement();
    const root = document.body.appendChild(document.createElement("div"));
    root.innerHTML = new MarkdownIt().use(drawnMermaidFences).render("```mermaid\nflowchart LR\n  A --> B\n```\n");
    await expect.poll(() => root.querySelector("[data-mermaid-card] pre")?.textContent).toContain("A --> B");
  });
});
