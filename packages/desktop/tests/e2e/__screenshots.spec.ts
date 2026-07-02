/**
 * TEMP: visual state capture for CSS tuning — deleted after use.
 */
import { test, expect, type Page } from "@playwright/test";

test.use({ deviceScaleFactor: 2, viewport: { width: 1280, height: 800 } });

const WORKSPACE = "/e2e-shot-ws";
const FILE_NAME = "notes.md";
const FILE_PATH = `${WORKSPACE}/${FILE_NAME}`;
const OUT =
  "/private/tmp/claude-501/-Users-parsa-Documents-metrists/344e13a1-d557-42d1-957a-a09168ba0c36/scratchpad";

const FIXTURE = [
  "# Visual Fixture",
  "",
  "A paragraph to hover for the drag handle.",
  "",
  "- bullet item one",
  "- bullet item two",
  "",
  "1. ordered item",
  "2. ordered item two",
  "",
  "- [ ] unchecked task item",
  "- [x] checked task item",
  "- [ ] a much longer task item that should wrap onto multiple lines to show how continuation lines align with the checkbox above",
  "",
  "Trailing paragraph with text to place the caret after.",
  "",
].join("\n");

async function openFixture(page: Page) {
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>).__METRISTS_FORCE_INDEXEDDB__ =
      true;
  });
  await page.goto("/welcome");
  await page.evaluate(
    async ({ filePath, content }) => {
      const db: IDBDatabase = await new Promise((resolve, reject) => {
        const req = indexedDB.open("metrists-fs", 1);
        req.onerror = () => reject(req.error);
        req.onsuccess = () => resolve(req.result);
        req.onupgradeneeded = (event) => {
          const database = (event.target as IDBOpenDBRequest).result;
          if (!database.objectStoreNames.contains("files")) {
            database.createObjectStore("files", { keyPath: "path" });
          }
        };
      });
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(["files"], "readwrite");
        tx.objectStore("files").put({
          path: filePath,
          content,
          modifiedAt: new Date(),
          createdAt: new Date(),
        });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    },
    { filePath: FILE_PATH, content: FIXTURE },
  );
  await page.goto(`/${encodeURIComponent(WORKSPACE)}`);
  await page.getByRole("button", { name: FILE_NAME }).click();
  await expect(page.locator(".ProseMirror")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".ProseMirror")).toBeFocused({ timeout: 5_000 });
}

test("capture editor visual state", async ({ page }) => {
  await openFixture(page);

  // 1. task list + lists area
  await page
    .locator('ul[data-type="taskList"]')
    .first()
    .screenshot({ path: `${OUT}/tasklist.png` });

  // 2. drag handle over a paragraph
  await page
    .locator(".ProseMirror p", { hasText: "A paragraph to hover" })
    .hover();
  await expect(page.locator(".drag-handle")).toBeVisible();
  await page
    .locator(".tiptap-editor-wrapper")
    .screenshot({ path: `${OUT}/handle-paragraph.png` });

  // 3. drag handle over a bullet list item (hover the text specifically)
  await page
    .locator(".ProseMirror li", { hasText: "bullet item one" })
    .hover({ position: { x: 40, y: 10 } });
  await page.waitForTimeout(600);
  await page
    .locator(".tiptap-editor-wrapper")
    .screenshot({ path: `${OUT}/handle-bullet.png` });

  // 3b. drag handle over a task list item
  await page
    .locator('ul[data-type="taskList"] > li', { hasText: "unchecked task" })
    .hover();
  await page.waitForTimeout(600);
  await page
    .locator(".tiptap-editor-wrapper")
    .screenshot({ path: `${OUT}/handle-task.png` });

  // 4. caret at end of text (zoomed area shot)
  const trailing = page.locator(".ProseMirror p", {
    hasText: "Trailing paragraph",
  });
  await trailing.click();
  await page.keyboard.press("End");
  await page.waitForTimeout(400);
  await trailing.screenshot({ path: `${OUT}/caret-end.png` });

  // full editor for context
  await page
    .locator(".tiptap-editor-wrapper")
    .screenshot({ path: `${OUT}/editor-full.png` });
});
