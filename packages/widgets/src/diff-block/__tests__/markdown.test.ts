import { describe, it, expect } from "vitest";
import MarkdownIt from "markdown-it";
import { diffFences, drawnDiffFences } from "../markdown";

const FENCE = "```ts diff=src/a.ts\nconst a = 1;\n=======\nconst a = 2;\n\n```\n";

describe("diff fences in markdown-it", () => {
  it("keep the diff on the code element, beside the language", () => {
    expect(new MarkdownIt().use(diffFences).render(FENCE)).toBe(
      '<pre><code data-diff="src/a.ts" class="language-ts">const a = 1;\n=======\nconst a = 2;\n\n</code></pre>\n',
    );
  });

  it("wrap a diff in its element, its text as the editor holds it", () => {
    expect(new MarkdownIt().use(drawnDiffFences).render(FENCE)).toBe(
      '<notefig-diff-block><pre><code data-diff="src/a.ts" class="language-ts">const a = 1;\n=======\nconst a = 2;\n</code></pre></notefig-diff-block>\n',
    );
  });

  it("leave other fences alone", () => {
    const md = new MarkdownIt().use(drawnDiffFences);
    expect(md.render("```ts\nconst a = 1;\n```\n")).toBe(new MarkdownIt().render("```ts\nconst a = 1;\n```\n"));
    expect(md.render("```diff\n-a\n+b\n```\n")).toBe('<pre><code class="language-diff">-a\n+b\n</code></pre>\n');
  });
});
