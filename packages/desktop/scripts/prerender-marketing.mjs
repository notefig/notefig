// Prerender the marketing build (MET-141).
//
// Boots the built site under `vite preview`, visits every route in a real
// browser, and snapshots the fully-rendered DOM into per-route
// `dist-marketing/<route>/index.html` files. Cloudflare Pages serves static
// assets before `_redirects`, so these files win over the SPA fallback and
// crawlers (and first paints) get full HTML without JavaScript.
//
// The snapshot is injected as a `#prerender` overlay next to the empty
// `#root`; the live app replaces it once the same content has mounted
// (src/marketing/prerender.ts). Replace, not hydrate — the snapshot is
// post-JS DOM, so React hydration would mismatch by construction.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(packageRoot, "dist-marketing");
const contentDir = path.join(packageRoot, "marketing-content", "docs");
const SITE_ORIGIN = "https://notefig.com";
const PREVIEW_URL = "http://localhost:4180";

function parseFrontmatter(raw) {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n/);
  const fields = {};
  if (match) {
    for (const line of match[1].split("\n")) {
      const separator = line.indexOf(":");
      if (separator === -1) continue;
      fields[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
    }
  }
  return fields;
}

function loadDocs() {
  return fs
    .readdirSync(contentDir)
    .filter((file) => file.endsWith(".md"))
    .map((file) => {
      const raw = fs.readFileSync(path.join(contentDir, file), "utf8");
      const frontmatter = parseFrontmatter(raw);
      return {
        slug: file.replace(/\.md$/, ""),
        title: frontmatter.title ?? file,
        description: frontmatter.description ?? "",
        order: Number(frontmatter.order ?? 0),
      };
    })
    .sort((a, b) => a.order - b.order || a.slug.localeCompare(b.slug));
}

async function waitForServer(url, timeoutMs = 30000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // still starting
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Preview server did not come up at ${url}`);
}

function escapeHtml(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function composePage(shellHtml, { title, description, canonicalPath, snapshot }) {
  let html = shellHtml;
  html = html.replace(/<title>[\s\S]*?<\/title>/, `<title>${escapeHtml(title)}</title>`);
  html = html.replace(
    /(<meta\s+name="description"\s+content=")[\s\S]*?("\s*\/>)/,
    `$1${escapeHtml(description)}$2`,
  );
  html = html.replace(
    /(<meta\s+property="og:title"\s+content=")[\s\S]*?("\s*\/>)/,
    `$1${escapeHtml(title)}$2`,
  );
  html = html.replace(
    /(<meta\s+property="og:description"\s+content=")[\s\S]*?("\s*\/>)/,
    `$1${escapeHtml(description)}$2`,
  );
  html = html.replace(
    /<link rel="canonical" href="[^"]*" \/>/,
    `<link rel="canonical" href="${SITE_ORIGIN}${canonicalPath}" />`,
  );
  html = html.replace(
    '<div id="root"></div>',
    `<div id="root"></div>\n    <div id="prerender">${snapshot}</div>`,
  );
  return html;
}

async function snapshotRoute(page, route) {
  await page.goto(`${PREVIEW_URL}${route}`, { waitUntil: "domcontentloaded" });
  // data-marketing-ready is stamped exactly when the live app would remove a
  // prerender overlay — i.e. when the route's real content is on screen.
  await page.waitForSelector("html[data-marketing-ready]", { timeout: 60000 });
  // Belt and braces: the workspace status bar flips to "Saved" after boot IO
  // settles; give layout/async paints a moment to converge.
  await page.waitForTimeout(500);
  return page.evaluate(() => {
    const root = document.getElementById("root");
    const clone = root.cloneNode(true);
    // Interactive-only attributes have no meaning in a static snapshot and
    // must not invite the browser to treat overlay text as editable.
    for (const element of clone.querySelectorAll(
      "[contenteditable], [autofocus], [data-marketing-ready]",
    )) {
      element.removeAttribute("contenteditable");
      element.removeAttribute("autofocus");
    }
    for (const element of clone.querySelectorAll("script, iframe")) {
      element.remove();
    }
    return clone.innerHTML;
  });
}

// `<route>.html` (not `<route>/index.html`): Cloudflare Pages and sirv both
// serve `/docs/x` from `docs/x.html` with no trailing-slash redirect, so the
// served URL matches the canonical exactly.
function writeRoute(routeFile, html) {
  fs.mkdirSync(path.dirname(routeFile), { recursive: true });
  fs.writeFileSync(routeFile, html);
}

async function main() {
  if (!fs.existsSync(path.join(outDir, "index.html"))) {
    throw new Error("dist-marketing/index.html missing — run the marketing build first");
  }
  const shellHtml = fs.readFileSync(path.join(outDir, "index.html"), "utf8");
  const docs = loadDocs();

  const preview = spawn(
    "npx",
    ["vite", "preview", "--config", "vite.marketing.config.ts"],
    { cwd: packageRoot, stdio: "ignore" },
  );

  try {
    await waitForServer(PREVIEW_URL);
    const browser = await chromium.launch();
    // One context for the whole run: the IndexedDB seed happens once and
    // every subsequent route boots against the seeded workspace.
    const page = await browser.newContext().then((context) => context.newPage());

    const landingSnapshot = await snapshotRoute(page, "/");
    const landingHtml = composePage(shellHtml, {
      title: "Notefig — Write Markdown. Continuously Publish.",
      description:
        "Notefig turns plain markdown files into published books and sites. Your content stays in files you own — write, commit, and every change ships itself.",
      canonicalPath: "/",
      snapshot: landingSnapshot,
    });
    fs.writeFileSync(path.join(outDir, "index.html"), landingHtml);
    console.log("prerendered /");

    const routes = [
      { route: "/docs", doc: docs[0], file: path.join(outDir, "docs.html") },
      ...docs.map((doc) => ({
        route: `/docs/${doc.slug}`,
        doc,
        file: path.join(outDir, "docs", `${doc.slug}.html`),
      })),
    ];

    for (const { route, doc, file } of routes) {
      const snapshot = await snapshotRoute(page, route);
      if (!snapshot.includes(doc.title.split(" ")[0])) {
        console.warn(`warning: snapshot for ${route} may be missing content`);
      }
      writeRoute(
        file,
        composePage(shellHtml, {
          title: `${doc.title} — Notefig Docs`,
          description: doc.description,
          canonicalPath: route === "/docs" ? "/docs" : route,
          snapshot,
        }),
      );
      console.log(`prerendered ${route}`);
    }

    await browser.close();

    const sitemapRoutes = ["/", "/docs", ...docs.map((doc) => `/docs/${doc.slug}`)];
    const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${sitemapRoutes
      .map((route) => `  <url><loc>${SITE_ORIGIN}${route}</loc></url>`)
      .join("\n")}\n</urlset>\n`;
    fs.writeFileSync(path.join(outDir, "sitemap.xml"), sitemap);
    console.log(`wrote sitemap.xml (${sitemapRoutes.length} routes)`);
  } finally {
    preview.kill();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
