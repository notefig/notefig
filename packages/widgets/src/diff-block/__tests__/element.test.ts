import { describe, it, expect, beforeAll } from "vitest";
import MarkdownIt from "markdown-it";
import { drawnDiffFences } from "../markdown";
import { defineDiffBlockElement } from "../element";

const md = new MarkdownIt().use(drawnDiffFences);

/** Rendered as chat renders it, once its diffs are drawn. */
async function render(markdown: string) {
  const root = document.createElement("div");
  document.body.append(root);
  root.innerHTML = md.render(markdown);
  await Promise.resolve();
  return root;
}

const lineTypes = (root: HTMLElement) =>
  [...root.querySelector("diffs-container")!.shadowRoot!.querySelectorAll("[data-line-type]:not([data-column-number])")].map(
    (line) => line.getAttribute("data-line-type"),
  );

describe("<notefig-diff-block>", () => {
  beforeAll(defineDiffBlockElement);

  it("draws the fence it holds as a diff, its file as the header", async () => {
    const root = await render("```ts diff=src/a.ts\nconst a = 1;\n=======\nconst a = 2;\n```\n");
    expect(root.querySelector("pre")!.hidden).toBe(true);
    await expect.poll(() => lineTypes(root)).toEqual(["change-deletion", "change-addition"]);
    expect(root.querySelector("diffs-container")!.shadowRoot!.textContent).toContain("src/a.ts");
    root.remove();
  });

  it("stays the code it holds without a separator", async () => {
    const root = await render("```ts diff\nconst a = 1;\n```\n");
    expect(root.querySelector("diffs-container")).toBeNull();
    expect(root.querySelector("pre")!.hidden).toBe(false);
    root.remove();
  });

  it("frees its diff when it leaves the page, and draws again when back", async () => {
    const root = await render("```ts diff\na\n=======\nb\n```\n");
    const element = root.firstElementChild!;
    element.remove();
    expect(element.querySelector("diffs-container")).toBeNull();
    expect(element.querySelector("pre")!.hidden).toBe(false);
    root.append(element);
    await Promise.resolve();
    expect(element.querySelectorAll("diffs-container")).toHaveLength(1);
    root.remove();
  });
});
