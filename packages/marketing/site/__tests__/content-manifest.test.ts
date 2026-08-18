import { describe, expect, it } from "vitest";
import {
  MARKETING_WORKSPACE,
  defaultDoc,
  findDoc,
  manifestHash,
  marketingDocs,
  parseFrontmatter,
} from "../content-manifest";

describe("parseFrontmatter", () => {
  it("splits frontmatter fields from the markdown body", () => {
    const { frontmatter, markdown } = parseFrontmatter(
      "---\ntitle: Quick Start\ndescription: Get going fast.\norder: 3\n---\n\n# Quick Start\n\nBody.\n",
    );
    expect(frontmatter).toEqual({
      title: "Quick Start",
      description: "Get going fast.",
      order: 3,
    });
    expect(markdown).toBe("# Quick Start\n\nBody.\n");
  });

  it("treats a file without frontmatter as pure markdown", () => {
    const { frontmatter, markdown } = parseFrontmatter("# Title\n\nBody.\n");
    expect(frontmatter.order).toBe(0);
    expect(markdown).toBe("# Title\n\nBody.\n");
  });

  it("keeps colons inside values intact", () => {
    const { frontmatter } = parseFrontmatter(
      "---\ntitle: Notefig: the app\ndescription: a\norder: 0\n---\nx",
    );
    expect(frontmatter.title).toBe("Notefig: the app");
  });
});

describe("marketing manifest", () => {
  it("has at least the core docs pages", () => {
    for (const slug of ["index", "quickstart", "editor", "cli"]) {
      expect(findDoc(slug), slug).toBeDefined();
    }
  });

  it("gives every doc a title, description, and workspace path", () => {
    for (const doc of marketingDocs) {
      expect(doc.title.length, doc.slug).toBeGreaterThan(0);
      expect(doc.description.length, doc.slug).toBeGreaterThan(0);
      expect(doc.path).toBe(`${MARKETING_WORKSPACE}/${doc.slug}.md`);
      expect(doc.markdown.startsWith("---"), doc.slug).toBe(false);
    }
  });

  it("has unique slugs and a stable order", () => {
    const slugs = marketingDocs.map((doc) => doc.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    const orders = marketingDocs.map((doc) => doc.order);
    expect([...orders].sort((a, b) => a - b)).toEqual(orders);
  });

  it("lands /docs on the introduction", () => {
    expect(defaultDoc.slug).toBe("index");
  });

  it("derives a content-addressed manifest hash", () => {
    expect(manifestHash).toMatch(/^[0-9a-f]{32}$/);
  });
});
