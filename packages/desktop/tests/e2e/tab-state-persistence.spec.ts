/**
 * Tab state persistence — what a tab must remember while it is not the
 * selected tab in its window.
 *
 * The dock mounts only the selected tab, so everything a tab type does not
 * explicitly persist outside React dies on every tab switch. These are the
 * user-visible symptoms of that.
 */
import { expect, test, type Page } from "@playwright/test";
import {
  openFileInNewTab,
  openFileInTree,
  openWorkspace,
  seedTestFiles,
  setupTestDatabase,
  waitForFileTree,
} from "../setup/test-helpers";

const WORKSPACE_PATH = "/workspace/tab-state";

const longDocument = Array.from(
  { length: 200 },
  (_, index) => `Line ${index + 1} of the long document.`,
).join("\n\n");

const fixtureFiles = [
  {
    path: `${WORKSPACE_PATH}/long.md`,
    content: longDocument,
    type: "file" as const,
  },
  {
    path: `${WORKSPACE_PATH}/other.md`,
    content: "a short second document",
    type: "file" as const,
  },
];

async function clickTab(page: Page, name: string) {
  const tabBar = page.locator('[data-testid="tab-bar"]');
  await tabBar.locator(`.cursor-pointer:has-text("${name}")`).first().click();
  await page.waitForTimeout(300);
}

/** scrollTop of the visible editor's scroll container. */
async function visibleEditorScrollTop(page: Page): Promise<number> {
  return page.evaluate(() => {
    const wrappers = Array.from(
      document.querySelectorAll<HTMLElement>(".tiptap-editor-wrapper"),
    );
    const visible = wrappers.find((el) => el.offsetParent !== null);
    return visible ? visible.scrollTop : -1;
  });
}

test.describe("tab state persistence", () => {
  test.beforeEach(async ({ page }, testInfo) => {
    await setupTestDatabase(page, testInfo.title);
    await openWorkspace(page, WORKSPACE_PATH);
    await seedTestFiles(page, fixtureFiles);
    await page.reload();
    await waitForFileTree(page);
  });

  test("scroll position survives switching away and back", async ({ page }) => {
    await openFileInTree(page, "long.md");
    await openFileInNewTab(page, "other.md");

    await clickTab(page, "long.md");

    await page.evaluate(() => {
      const wrappers = Array.from(
        document.querySelectorAll<HTMLElement>(".tiptap-editor-wrapper"),
      );
      const visible = wrappers.find((el) => el.offsetParent !== null);
      visible?.scrollTo({ top: 800 });
    });
    await page.waitForTimeout(200);
    const before = await visibleEditorScrollTop(page);
    expect(before).toBeGreaterThan(400);

    await clickTab(page, "other.md");
    await clickTab(page, "long.md");

    // Restored to the top of the block that was at the top edge, so the
    // offset lands within a line height of where it was — not at the caret,
    // which is still up at the start of the document.
    expect(await visibleEditorScrollTop(page)).toBeGreaterThan(before - 40);
  });

  test("caret position survives switching away and back", async ({ page }) => {
    await openFileInTree(page, "long.md");
    await openFileInNewTab(page, "other.md");

    await clickTab(page, "long.md");

    // Click into a paragraph well down the document, then type so the caret
    // is somewhere unambiguous.
    const paragraph = page
      .locator('[role="textbox"]:visible p:has-text("Line 12 of")')
      .first();
    await paragraph.click();
    await page.keyboard.type("!");
    await page.waitForTimeout(200);
    const before = await page.evaluate(
      () => window.getSelection()?.anchorNode?.textContent ?? "",
    );
    expect(before).toContain("Line 12 of");

    await clickTab(page, "other.md");
    await clickTab(page, "long.md");
    await page.waitForTimeout(300);

    const after = await page.evaluate(
      () => window.getSelection()?.anchorNode?.textContent ?? "",
    );
    expect(after).toBe(before);
  });
});
