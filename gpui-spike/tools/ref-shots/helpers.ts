// Open a seeded workspace in the TS app, the way its e2e suite does.
import type { Page } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { setupTestDatabase, seedTestFiles, openWorkspace, waitForFileTree } from "/Users/parsa/Documents/notefig/packages/desktop/tests/setup/test-helpers";

export const OUT = path.join(__dirname, "out");

export const DEMO_FILES = [
  { path: "/ref-ws/README.md", type: "file" as const, content: "# Demo Workspace\n\nWelcome to **Notefig**. A list:\n\n- one\n- two\n\n> a quote\n\n```ts\nconst x = 1;\n```\n" },
  { path: "/ref-ws/docs/getting-started.md", type: "file" as const, content: "# Getting started\n\nOpen a folder, write markdown, press / for AI.\n" },
  { path: "/ref-ws/notes/ideas.md", type: "file" as const, content: "# Ideas\n\n- [ ] try GPUI\n- [x] write specs\n" },
];

export async function openDemo(page: Page, files = DEMO_FILES) {
  await page.addInitScript(() => { (window as any).__METRISTS_FORCE_INDEXEDDB__ = true; });
  await setupTestDatabase(page, "ref" + Date.now() + Math.random());
  await openWorkspace(page, "/ref-ws");
  await seedTestFiles(page, files);
  await page.reload();
  await waitForFileTree(page, "README.md");
}

/** Screenshot plus the accessibility tree, as out/<name>.png and out/<name>.aria.txt. */
export async function shot(page: Page, name: string) {
  fs.mkdirSync(OUT, { recursive: true });
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  fs.writeFileSync(path.join(OUT, `${name}.aria.txt`), await page.locator("body").ariaSnapshot());
}
