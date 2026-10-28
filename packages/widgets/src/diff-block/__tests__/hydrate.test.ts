import { describe, it, expect, afterEach } from "vitest";
import { createDiffBlockHydrator } from "../hydrate";

const fence = (language: string, text: string) => `<pre><code class="language-${language}">${text}\n</code></pre>`;
const DIFF = fence("diff:src/app.ts", "const a = 1;\n=======\nconst a = 2;");

let root: HTMLElement;
afterEach(() => root?.remove());

function render(html: string) {
  root ??= document.createElement("div");
  document.body.appendChild(root);
  root.innerHTML = html;
}

const diffs = () => [...root.querySelectorAll(".diff-block")];

describe("createDiffBlockHydrator", () => {
  it("swaps each diff fence for its diff, and leaves other fences", async () => {
    const hydrator = createDiffBlockHydrator();
    render(`<p>Hi</p>${DIFF}${fence("ts", "const a = 1;")}${fence("diff:ts", "no separator")}`);
    hydrator.hydrate(root);
    expect(diffs()).toHaveLength(1);
    expect(root.querySelectorAll("pre")).toHaveLength(2);
    const shadow = diffs()[0].querySelector("diffs-container")!.shadowRoot!;
    await expect.poll(() => shadow.querySelector("[data-title]")?.textContent).toBe("src/app.ts");
    hydrator.destroy();
  });

  it("moves a kept block's diff into new HTML, and frees one the HTML dropped", () => {
    const hydrator = createDiffBlockHydrator();
    render(DIFF);
    hydrator.hydrate(root);
    const [drawn] = diffs();

    // The next chunk of a streaming reply.
    render(`${DIFF}<p>More</p>`);
    hydrator.hydrate(root);
    expect(diffs()).toEqual([drawn]);

    render(fence("diff:ts", "a\n=======\nb"));
    hydrator.hydrate(root);
    expect(diffs()).toHaveLength(1);
    expect(diffs()[0]).not.toBe(drawn);
    expect(drawn.querySelector("diffs-container")).toBeNull();
    hydrator.destroy();
  });

  it("draws a repeated block twice, and keeps diffs already in place", () => {
    const hydrator = createDiffBlockHydrator();
    render(DIFF + DIFF);
    hydrator.hydrate(root);
    const drawn = diffs();
    expect(drawn).toHaveLength(2);
    hydrator.hydrate(root);
    expect(diffs()).toEqual(drawn);
    hydrator.destroy();
  });

  it("puts the fences back when destroyed, so hydrating again draws them", () => {
    const hydrator = createDiffBlockHydrator();
    render(DIFF);
    hydrator.hydrate(root);
    hydrator.destroy();
    expect(diffs()).toHaveLength(0);
    expect(root.querySelector("code")?.className).toBe("language-diff:src/app.ts");

    hydrator.hydrate(root);
    expect(diffs()).toHaveLength(1);
    hydrator.destroy();
  });
});
