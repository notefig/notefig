/**
 * Marketing content manifest — the single source of truth for the seeded
 * workspace, the site's link graph, the prerender route list and the sitemap.
 * Content lives as plain markdown + frontmatter in
 * `packages/marketing/content/pages/`.
 *
 * The directory layout IS the site map: `pages/docs/cli.md` is seeded as
 * `notefig/docs/cli.md` and served at `/docs/cli`. What a visitor sees in the
 * file tree and what they see in the address bar are the same structure.
 *
 * The frontmatter never reaches the seeded workspace: files are seeded as
 * pure markdown so the editor shows exactly what a visitor would write.
 */
import { calculateContentHash } from "@/utils/hash";

/**
 * Root of the seeded workspace. Invisible in URLs — `app-surface.tsx` feeds
 * it to the core `useWorkspaceParams` through an overridden route location,
 * so the address bar is free to mirror the content tree instead.
 */
export const WORKSPACE_ROOT = "notefig";

export interface MarketingPage {
  /** Path within the content tree, without extension: `docs/cli`. */
  id: string;
  /** Canonical URL path: `/docs/cli`. */
  route: string;
  /** Workspace file path, which doubles as the dockable tab id. */
  filePath: string;
  title: string;
  description: string;
  order: number;
  /** Frontmatter-stripped markdown, exactly what gets seeded. */
  markdown: string;
}

const rawPages = import.meta.glob<string>("../content/pages/**/*.md", {
  eager: true,
  query: "?raw",
  import: "default",
});

interface Frontmatter {
  title: string;
  description: string;
  order: number;
}

export function parseFrontmatter(raw: string): {
  frontmatter: Frontmatter;
  markdown: string;
} {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!match) {
    return {
      frontmatter: { title: "", description: "", order: 0 },
      markdown: raw,
    };
  }

  const fields: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    fields[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }

  return {
    frontmatter: {
      title: fields.title ?? "",
      description: fields.description ?? "",
      order: Number(fields.order ?? 0),
    },
    markdown: raw.slice(match[0].length).replace(/^[\r\n]+/, ""),
  };
}

/** `../content/pages/docs/cli.md` → `docs/cli`. */
export function pageIdFromModulePath(modulePath: string): string {
  return modulePath
    .replace(/^.*\/content\/pages\//, "")
    .replace(/\.md$/, "");
}

function buildPages(files: Record<string, string>): MarketingPage[] {
  const pages = Object.entries(files).map(([modulePath, raw]) => {
    const id = pageIdFromModulePath(modulePath);
    const { frontmatter, markdown } = parseFrontmatter(raw);
    return {
      id,
      route: `/${id}`,
      filePath: `${WORKSPACE_ROOT}/${id}.md`,
      title: frontmatter.title || id,
      description: frontmatter.description,
      order: frontmatter.order,
      markdown,
    };
  });

  return pages.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

export const marketingPages: MarketingPage[] = buildPages(rawPages);

export function findPageByRoute(route: string): MarketingPage | undefined {
  return marketingPages.find((page) => page.route === route);
}

export function findPageByFilePath(filePath: string): MarketingPage | undefined {
  return marketingPages.find((page) => page.filePath === filePath);
}

/** The page `/` opens. */
export const defaultPage: MarketingPage =
  findPageByRoute("/docs/index") ?? marketingPages[0];

/**
 * Hash over every seeded path + body. Deploys with changed content get a new
 * hash, which triggers a re-seed that overwrites any in-browser edits.
 */
export const manifestHash: string = calculateContentHash(
  marketingPages.map((page) => `${page.filePath}\n${page.markdown}`).join("\n \n"),
);
