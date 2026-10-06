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

/** True while the document holds focus with its caret in the draft
 *  (composer) of the widget carrying `blobId`. */
function caretInDraftOf(page: Page, blobId: string) {
  return page.evaluate((blobId) => {
    const node = window.getSelection()?.anchorNode ?? null;
    const element =
      node instanceof Element ? node : (node?.parentElement ?? null);
    const draft = element?.closest("[data-prompt-draft]");
    const widget = draft?.closest("[data-blob-id]");
    const editor = draft?.closest(".ProseMirror");
    return (
      widget?.getAttribute("data-blob-id") === blobId &&
      document.activeElement === editor
    );
  }, blobId);
}

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

  test("clicking a dot focuses that widget's composer", async ({ page }) => {
    await openFileInTree(page, "doc.md");
    const dots = minimap(page).first().getByRole("button");
    await expect(dots).toHaveCount(2);

    // Start with the caret in the prose, away from either widget.
    await page.getByText("closing paragraph").click();

    await dots.last().click();
    const secondWidget = page.locator('[data-blob-id="blob_mapbb"]').first();
    await expect(secondWidget).toBeInViewport({ timeout: 5000 });
    await expect.poll(() => caretInDraftOf(page, "blob_mapbb")).toBe(true);

    // Typing lands in that composer, not the prose.
    await page.keyboard.type("from the minimap");
    await expect(
      secondWidget.locator("[data-prompt-draft]").first(),
    ).toHaveText("from the minimap");
  });
});
