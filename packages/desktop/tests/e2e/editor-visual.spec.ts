/**
 * Visual/interaction checks for the Tiptap editor against the real app
 * (browser platform, pure IndexedDB adapter — see AGENTS.md).
 *
 * Covers the runtime halves of:
 *  - Bug #2: task item checkbox and text must sit on the same line
 *  - Bug #3: drag handle must be block-scoped (small, near the hovered block)
 *  - Bug #4: inserted 3x3 table must render 9 visibly bordered cells
 */
import { test, expect, type Page } from "@playwright/test";

// Workspace paths are absolute and travel percent-encoded in a single URL
// segment (see utils/routing.ts buildEditFileUrl).
const WORKSPACE = "/e2e-editor-ws";
const FILE_NAME = "notes.md";
const FILE_PATH = `${WORKSPACE}/${FILE_NAME}`;

const FIXTURE = [
  "# E2E Fixture",
  "",
  "First paragraph for drag handle checks.",
  "",
  "Second paragraph so there is a drop target.",
  "",
  "- [ ] unchecked task",
  "- [x] checked task",
  "",
  "| Name | Age |",
  "| --- | --- |",
  "| Alice | 30 |",
  "",
].join("\n");

async function seedWorkspace(page: Page) {
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>).__METRISTS_FORCE_INDEXEDDB__ =
      true;
  });

  // Must be on the app origin before touching IndexedDB.
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
        const store = tx.objectStore("files");
        store.put({
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
}

async function openFixtureFile(page: Page) {
  await seedWorkspace(page);
  await page.goto(`/${encodeURIComponent(WORKSPACE)}`);
  // deep links mark the file active but don't open a tab — click like a user
  await page.getByRole("button", { name: FILE_NAME }).click();
  await expect(page.locator(".ProseMirror")).toBeVisible({ timeout: 15_000 });
  await expect(
    page.locator(".ProseMirror h1", { hasText: "E2E Fixture" }),
  ).toBeVisible();
}

test.describe("task list rendering (Bug #2)", () => {
  test("checkbox and text share the same line", async ({ page }) => {
    await openFixtureFile(page);

    const item = page.locator('ul[data-type="taskList"] > li').first();
    await expect(item).toBeVisible();

    const label = item.locator("label");
    const text = item.locator("div p").first();
    const labelBox = await label.boundingBox();
    const textBox = await text.boundingBox();

    expect(labelBox).not.toBeNull();
    expect(textBox).not.toBeNull();
    // vertical centers within half a line-height of each other
    const labelCenter = labelBox!.y + labelBox!.height / 2;
    const textCenter = textBox!.y + textBox!.height / 2;
    expect(Math.abs(labelCenter - textCenter)).toBeLessThan(12);
    // checkbox left of text, not above it
    expect(labelBox!.x + labelBox!.width).toBeLessThanOrEqual(textBox!.x + 1);
  });

  test("checked state renders from markdown", async ({ page }) => {
    await openFixtureFile(page);

    const checked = page.locator(
      'ul[data-type="taskList"] > li[data-checked="true"] input',
    );
    await expect(checked).toBeChecked();
  });
});

test.describe("drag handle (Bug #3)", () => {
  test("handle is small and anchored to the hovered block", async ({
    page,
  }) => {
    await openFixtureFile(page);

    const paragraph = page.locator(".ProseMirror p", {
      hasText: "First paragraph",
    });
    await paragraph.hover();

    const handle = page.locator(".drag-handle");
    await expect(handle).toBeVisible();

    const handleBox = await handle.boundingBox();
    const paragraphBox = await paragraph.boundingBox();
    const editorBox = await page.locator(".ProseMirror").boundingBox();

    expect(handleBox).not.toBeNull();
    // Block-scoped: icon-sized, not stretched over the editor
    expect(handleBox!.width).toBeLessThan(40);
    expect(handleBox!.height).toBeLessThan(40);
    expect(handleBox!.width).toBeLessThan(editorBox!.width / 4);
    // Anchored to the hovered paragraph's line, to its left
    const handleCenter = handleBox!.y + handleBox!.height / 2;
    expect(
      Math.abs(handleCenter - (paragraphBox!.y + paragraphBox!.height / 2)),
    ).toBeLessThan(paragraphBox!.height + 8);
    expect(handleBox!.x).toBeLessThan(paragraphBox!.x);
  });

  test("handle follows the hovered block", async ({ page }) => {
    await openFixtureFile(page);

    const first = page.locator(".ProseMirror p", {
      hasText: "First paragraph",
    });
    const second = page.locator(".ProseMirror p", {
      hasText: "Second paragraph",
    });
    const handle = page.locator(".drag-handle");

    await first.hover();
    await expect(handle).toBeVisible();
    const boxOnFirst = await handle.boundingBox();

    await second.hover();
    await expect
      .poll(async () => (await handle.boundingBox())?.y, { timeout: 3_000 })
      .toBeGreaterThan(boxOnFirst!.y + 5);
  });
});

test.describe("tables (Bug #4)", () => {
  test("markdown pipe table renders bordered cells", async ({ page }) => {
    await openFixtureFile(page);

    const table = page.locator(".ProseMirror table").first();
    await expect(table).toBeVisible();
    await expect(table.locator("th")).toHaveCount(2);
    await expect(table.locator("td")).toHaveCount(2);

    const borderWidth = await table
      .locator("td")
      .first()
      .evaluate((el) => getComputedStyle(el).borderTopWidth);
    expect(parseFloat(borderWidth)).toBeGreaterThan(0);
  });

  test("insert-table toolbar button creates a visible 3x3 grid", async ({
    page,
  }) => {
    await openFixtureFile(page);

    // place cursor at the end of the document so the table has room
    await page.locator(".ProseMirror p", { hasText: "Second paragraph" }).click();
    await page.getByRole("button", { name: "Insert Table" }).click();

    const table = page.locator(".ProseMirror table").nth(1);
    await expect(table).toBeVisible();
    await expect(table.locator("tr")).toHaveCount(3);
    await expect(table.locator("th")).toHaveCount(3);
    await expect(table.locator("td")).toHaveCount(6);

    // all 9 cells visibly laid out: header cells side by side, rows stacked
    const cells = table.locator("th, td");
    const firstCell = await cells.nth(0).boundingBox();
    const secondCell = await cells.nth(1).boundingBox();
    const lastCell = await cells.nth(8).boundingBox();
    expect(secondCell!.x).toBeGreaterThan(firstCell!.x + 10);
    expect(lastCell!.y).toBeGreaterThan(firstCell!.y + 10);
  });
});

test.describe("task item input rule (Bug #7 UX path)", () => {
  test("typing [] at line start creates a task item, not literal text", async ({
    page,
  }) => {
    await openFixtureFile(page);

    const editor = page.locator(".ProseMirror");
    // new paragraph at the end of the doc
    await editor.click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("[] fresh task", { delay: 20 });

    const item = page.locator('ul[data-type="taskList"] > li', {
      hasText: "fresh task",
    });
    await expect(item).toBeVisible();
    await expect(item.locator("input[type=checkbox]")).toHaveCount(1);
    // the literal "[]" must be consumed by the input rule
    await expect(item).not.toContainText("[]");
  });
});
