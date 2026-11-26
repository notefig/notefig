import { describe, it, expect } from "vitest";
import MarkdownIt from "markdown-it";
import { drawnDiffFences } from "../../diff-block/markdown";
import { drawnMermaidFences } from "../markdown";

const md = new MarkdownIt().use(drawnDiffFences).use(drawnMermaidFences);

describe("mermaid fences in markdown-it", () => {
  it("wrap a diagram in its element, its text as the editor holds it", () => {
    expect(md.render("```mermaid\nflowchart LR\n  A --> B\n```\n")).toBe(
      '<notefig-mermaid-block><pre><code class="language-mermaid">flowchart LR\n  A --&gt; B</code></pre></notefig-mermaid-block>\n',
    );
  });

  it("leave other fences alone, a diff of a diagram included", () => {
    expect(md.render("```ts\nconst a = 1;\n```\n")).toBe(new MarkdownIt().render("```ts\nconst a = 1;\n```\n"));
    const diff = "```mermaid diff\n--- a.mmd\n+++ a.mmd\n@@ -1 +1 @@\n-A\n+B\n```\n";
    expect(md.render(diff)).toMatch(/^<notefig-diff-block>/);
  });
});
