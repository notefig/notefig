import { describe, it, expect, beforeAll } from "vitest";
import MarkdownIt from "markdown-it";
import { drawnDiffFences } from "../markdown";
import { defineDiffBlockElement, parseDiffBlock } from "../element";

const md = new MarkdownIt().use(drawnDiffFences);
const PATCH = "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,2 @@\n const a = 1;\n-const b = 2;\n+const b = 3;";

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

describe("parseDiffBlock", () => {
  it("reads a unified diff as Pierre does, in the block's language", () => {
    const diff = parseDiffBlock("ts", `diff --git a/src/a.ts b/src/a.ts\n${PATCH}`)!;
    expect(diff).toMatchObject({ name: "src/a.ts", lang: "ts", hunks: [expect.anything()] });
    // Pierre infers one from the name for a language Shiki doesn't know.
    expect(parseDiffBlock("nope", PATCH)!.lang).toBeUndefined();
  });

  it("is null for a body with no hunks", () => {
    expect(parseDiffBlock("ts", "-const b = 2;\n+const b = 3;")).toBeNull();
    expect(parseDiffBlock("ts", "const a = 1;")).toBeNull();
  });
});

describe("<notefig-diff-block>", () => {
  beforeAll(defineDiffBlockElement);

  it("draws the patch it holds as a diff, its file as the header", async () => {
    const root = await render(`\`\`\`ts diff\ndiff --git a/src/a.ts b/src/a.ts\n${PATCH}\n\`\`\`\n`);
    expect(root.querySelector("pre")!.hidden).toBe(true);
    await expect.poll(() => lineTypes(root)).toEqual(["context", "change-deletion", "change-addition"]);
    expect(root.querySelector("diffs-container")!.shadowRoot!.textContent).toContain("src/a.ts");
    root.remove();
  });

  it("stays the code it holds when Pierre finds no hunks in it", async () => {
    const root = await render("```ts diff\n-a\n+b\n```\n");
    expect(root.querySelector("diffs-container")).toBeNull();
    expect(root.querySelector("pre")!.hidden).toBe(false);
    root.remove();
  });

  it("frees its diff when it leaves the page, and draws again when back", async () => {
    const root = await render(`\`\`\`ts diff\n${PATCH}\n\`\`\`\n`);
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
