// Prerender the marketing site (MET-141).
//
// Boots the built site under `vite preview`, visits every route in a real
// browser, and snapshots the fully-rendered DOM into per-route files under
// `dist-site/`. Cloudflare Pages serves static assets before `_redirects`,
// so these files win over the SPA fallback and crawlers (and first paints)
// get full HTML without JavaScript.
//
// The snapshot is injected as a `#prerender` overlay next to the empty
// `#root`; the live app replaces it once the same content has mounted
// (site/prerender.ts). Replace, not hydrate — the snapshot is post-JS DOM,
// so React hydration would mismatch by construction.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(packageRoot, "dist-site");
const SITE_ORIGIN = "https://notefig.com";
const PREVIEW_URL = "http://localhost:4180";

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

async function prerenderLanding(page, shellHtml) {
  const snapshot = await snapshotRoute(page, "/");
  // The route list lives in the app (window.__MARKETING_ROUTES__, set by
  // site/main.tsx from the content manifest) — one parser total.
  const pages = await page.evaluate(() => window.__MARKETING_ROUTES__);
  const html = composePage(shellHtml, {
    title: "Notefig — Write Markdown. Continuously Publish.",
    description:
      "Notefig turns plain markdown files into published books and sites. Your content stays in files you own — write, commit, and every change ships itself.",
    canonicalPath: "/",
    snapshot,
  });
  fs.writeFileSync(path.join(outDir, "index.html"), html);
  console.log("prerendered /");
  return pages;
}

// `/docs/cli` → `dist-site/docs/cli.html`, mirroring the content tree.
function routeFile(route) {
  return path.join(outDir, ...route.split("/").filter(Boolean)) + ".html";
}

async function prerenderPages(page, shellHtml, pages) {
  for (const entry of pages) {
    const snapshot = await snapshotRoute(page, entry.route);
    if (!snapshot.includes(entry.title.split(" ")[0])) {
      console.warn(`warning: snapshot for ${entry.route} may be missing content`);
    }
    writeRoute(
      routeFile(entry.route),
      composePage(shellHtml, {
        title: `${entry.title} — Notefig`,
        description: entry.description,
        // The landing page shows this same content; point search engines
        // there rather than competing with ourselves for it.
        canonicalPath: entry.isDefault ? "/" : entry.route,
        snapshot,
      }),
    );
    console.log(`prerendered ${entry.route}`);
  }
}

function writeSitemap(pages) {
  // The default page is listed as "/" — its own route canonicalises there.
  const routes = [
    "/",
    ...pages.filter((entry) => !entry.isDefault).map((entry) => entry.route),
  ];
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${routes
    .map((route) => `  <url><loc>${SITE_ORIGIN}${route}</loc></url>`)
    .join("\n")}\n</urlset>\n`;
  fs.writeFileSync(path.join(outDir, "sitemap.xml"), sitemap);
  console.log(`wrote sitemap.xml (${routes.length} routes)`);
}

async function main() {
  if (!fs.existsSync(path.join(outDir, "index.html"))) {
    throw new Error("dist-site/index.html missing — run the site build first");
  }
  const shellHtml = fs.readFileSync(path.join(outDir, "index.html"), "utf8");

  const preview = spawn(
    "npx",
    ["vite", "preview", "--config", "vite.site.config.mts"],
    { cwd: packageRoot, stdio: "ignore" },
  );

  try {
    await waitForServer(PREVIEW_URL);
    const browser = await chromium.launch();
    // One context for the whole run: the IndexedDB seed happens once and
    // every subsequent route boots against the seeded workspace.
    const page = await browser.newContext().then((context) => context.newPage());

    const pages = await prerenderLanding(page, shellHtml);
    await prerenderPages(page, shellHtml, pages);
    await browser.close();
    writeSitemap(pages);
  } finally {
    preview.kill();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
