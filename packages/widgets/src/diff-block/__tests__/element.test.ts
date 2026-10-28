import { describe, it, expect, beforeAll } from "vitest";
import MarkdownIt from "markdown-it";
import { drawnDiffFences } from "../markdown";
import { defineDiffBlockElement } from "../element";

const md = new MarkdownIt().use(drawnDiffFences);
const PATCH = "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,2 @@\n const a = 1;\n-const b = 2;\n+const b = 3;";

/** Rendered as chat renders it, inside a workspace's view. */
function render(markdown: string) {
  const root = document.createElement("div");
  root.setAttribute("data-workspace-path", "/ws");
  document.body.append(root);
  root.innerHTML = md.render(markdown);
  return root;
}

const card = (root: Element) => root.querySelector("[data-diff-card]");
const lineTypes = (root: Element) =>
  [...(root.querySelector("diffs-container")?.shadowRoot?.querySelectorAll("[data-line-type]:not([data-column-number])") ?? [])].map(
    (line) => line.getAttribute("data-line-type"),
  );

describe("<notefig-diff-block>", () => {
  const resolved: [string | null, string][] = [];
  beforeAll(() =>
    defineDiffBlockElement({
      resolveFile: (workspace, path) => {
        resolved.push([workspace, path]);
        return { label: path };
      },
    }),
  );

  it("draws the patch it holds as its card, the file named in its header", async () => {
    const root = render(`\`\`\`ts diff\ndiff --git a/src/a.ts b/src/a.ts\n${PATCH}\n\`\`\`\n`);
    await expect.poll(() => lineTypes(root)).toEqual(["context", "change-deletion", "change-addition"]);
    expect(root.querySelector("pre")!.hidden).toBe(true);
    expect(card(root)!.textContent).toContain("src/a.ts");
    expect(card(root)!.textContent).toContain("+1");
    expect(card(root)!.textContent).toContain("−1");
    // Asked of the host from the workspace its page shows.
    expect(resolved).toContainEqual(["/ws", "src/a.ts"]);
    root.remove();
  });

  it("numbers its lines from the hunk's header", async () => {
    const root = render("```ts diff\n--- a.ts\n+++ a.ts\n@@ -41,2 +41,2 @@\n keep\n-old\n+new\n```\n");
    const numbers = () =>
      [...(root.querySelector("diffs-container")?.shadowRoot?.querySelectorAll("[data-column-number]") ?? [])].map((cell) =>
        cell.textContent?.trim(),
      );
    await expect.poll(numbers).toContain("42");
    expect(numbers()).toContain("41");
    expect(numbers()).not.toContain("1");
    root.remove();
  });

  it("stays the code it holds when Pierre finds no hunks in it", async () => {
    const root = render("```ts diff\n-a\n+b\n```\n");
    await Promise.resolve();
    expect(card(root)).toBeNull();
    expect(root.querySelector("pre")!.hidden).toBe(false);
    root.remove();
  });

  it("frees its card when it leaves the page, and draws again when back", async () => {
    const root = render(`\`\`\`ts diff\n${PATCH}\n\`\`\`\n`);
    const element = root.firstElementChild!;
    await expect.poll(() => card(element)).not.toBeNull();
    element.remove();
    expect(card(element)).toBeNull();
    expect(element.querySelector("pre")!.hidden).toBe(false);
    root.append(element);
    await expect.poll(() => element.querySelectorAll("[data-diff-card]").length).toBe(1);
    root.remove();
  });
});
