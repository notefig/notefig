/**
 * The widget minimap (MET-172): a thin strip above the document with one
 * dot per prompt widget — hover reveals the title, click scrolls the
 * widget into view.
 */
import { test, expect, type Page } from "@playwright/test";
import {
  openFileInTree,
  openWorkspace,
  seedTestFiles,
  setupTestDatabase,
  waitForFileTree,
} from "../setup/test-helpers";

const WS = "/workspace/widget-minimap";
const MARKER = (n: string) =>
  `<!-- notefig:prompt id="blob_map${n}" task="task_map${n}" -->`;

const LONG_DOC = [
  "# Top",
  "",
  MARKER("aa"),
  "",
  ...Array.from({ length: 120 }, (_, i) => `Filler line ${i} keeps the document tall.\n`),
  MARKER("bb"),
  "",
  "closing paragraph",
  "",
].join("\n");

function minimap(page: Page) {
  return page.locator("[data-widget-minimap]").locator("visible=true");
}

test.describe("widget minimap", () => {
  test.beforeEach(async ({ page }) => {
    await setupTestDatabase(page, "widget-minimap");
    await openWorkspace(page, WS);
    await seedTestFiles(page, [
      { path: `${WS}/doc.md`, content: LONG_DOC, type: "file" as const },
      { path: `${WS}/plain.md`, content: "no widgets here\n", type: "file" as const },
    ]);
    await page.reload();
    await waitForFileTree(page, "doc.md");
  });

  test("shows a dot per widget, jumps on click, hides without widgets", async ({
    page,
  }) => {
    await openFileInTree(page, "doc.md");
    const strip = minimap(page).first();
    await expect(strip).toBeVisible();
    const dots = strip.getByRole("button");
    await expect(dots).toHaveCount(2);

    // Hover reveals the title sliver (restored widgets carry no prompt
    // text, so the generic label shows).
    await dots.last().hover();
    await expect(dots.last()).toContainText("Prompt");

    // Click the second dot: the far widget scrolls into the viewport.
    const secondWidget = page.locator('[data-blob-id="blob_mapbb"]').first();
    await dots.last().click();
    await expect(secondWidget).toBeInViewport({ timeout: 5000 });

    // A widget-less document renders no minimap.
    await openFileInTree(page, "plain.md");
    await expect(minimap(page)).toHaveCount(0);
  });
});
