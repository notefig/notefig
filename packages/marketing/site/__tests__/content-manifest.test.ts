import { describe, expect, it } from "vitest";
import {
  WORKSPACE_ROOT,
  defaultPage,
  findPageByFilePath,
  findPageByRoute,
  manifestHash,
  marketingPages,
  pageIdFromModulePath,
  parseFrontmatter,
} from "../content-manifest";

describe("parseFrontmatter", () => {
  it("splits frontmatter fields from the markdown body", () => {
    const { frontmatter, markdown } = parseFrontmatter(
      "---\ntitle: CLI\ndescription: Build and publish\norder: 3\n---\n\n# CLI\n\nbody\n",
    );
    expect(frontmatter).toEqual({
      title: "CLI",
      description: "Build and publish",
      order: 3,
    });
    expect(markdown).toBe("# CLI\n\nbody\n");
  });

  it("keeps colons in values", () => {
    const { frontmatter } = parseFrontmatter(
      "---\ntitle: Notefig: the editor\ndescription: x\norder: 0\n---\nbody\n",
    );
    expect(frontmatter.title).toBe("Notefig: the editor");
  });

  it("passes bodies without frontmatter through untouched", () => {
    const raw = "# No frontmatter\n";
    expect(parseFrontmatter(raw).markdown).toBe(raw);
  });

  it("strips frontmatter when the file uses Windows line endings", () => {
    const { frontmatter, markdown } = parseFrontmatter(
      "---\r\ntitle: Advanced\r\ndescription: Self-hosted\r\norder: 10\r\n---\r\n\r\n# Advanced\r\n",
    );
    expect(frontmatter.title).toBe("Advanced");
    expect(frontmatter.description).toBe("Self-hosted");
    expect(markdown.startsWith("# Advanced")).toBe(true);
  });
});

describe("pageIdFromModulePath", () => {
  it("mirrors the content tree, nesting included", () => {
    expect(pageIdFromModulePath("../content/pages/docs/cli.md")).toBe(
      "docs/cli",
    );
    expect(pageIdFromModulePath("../content/pages/download.md")).toBe(
      "download",
    );
  });
});

describe("marketing pages", () => {
  it("gives every page a title, description, route and workspace path", () => {
    for (const page of marketingPages) {
      expect(page.title.length, page.id).toBeGreaterThan(0);
      expect(page.description.length, page.id).toBeGreaterThan(0);
      expect(page.route).toBe(`/${page.id}`);
      expect(page.filePath).toBe(`${WORKSPACE_ROOT}/${page.id}.md`);
      expect(page.markdown.startsWith("---"), page.id).toBe(false);
    }
  });

  it("keeps the docs in their own directory", () => {
    const docs = marketingPages.filter((page) => page.id.startsWith("docs/"));
    expect(docs.length).toBeGreaterThan(5);
    expect(findPageByRoute("/download")).toBeDefined();
  });

  it("has unique routes and a stable order", () => {
    const routes = marketingPages.map((page) => page.route);
    expect(new Set(routes).size).toBe(routes.length);
    const orders = marketingPages.map((page) => page.order);
    expect([...orders].sort((a, b) => a - b)).toEqual(orders);
  });

  it("looks pages up by route and by workspace file path", () => {
    const cli = findPageByRoute("/docs/cli");
    expect(cli).toBeDefined();
    expect(findPageByFilePath(cli!.filePath)).toBe(cli);
    expect(findPageByFilePath("notefig/whatever-a-visitor-made.md")).toBeUndefined();
  });

  it("lands / on the introduction", () => {
    expect(defaultPage.route).toBe("/docs/index");
  });

  it("derives a content-addressed manifest hash", () => {
    expect(manifestHash).toMatch(/^[0-9a-f]{32}$/);
  });
});
