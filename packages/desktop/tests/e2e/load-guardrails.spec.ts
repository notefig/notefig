import { test, expect } from "@playwright/test";
import {
  clearTestDatabase,
  getEditorContent,
  getIndexedDBContent,
  openFileInTree,
  openWorkspace,
  seedTestFiles,
  setupTestDatabase,
  waitForFileTree,
} from "../setup/test-helpers";

const workspacePath = "/workspace/load-guardrails";
const guardedFilePath = `${workspacePath}/guarded.md`;
const guardedFileName = "guarded.md";
const originalContent = "# Guarded\n\nOriginal content must remain intact.";

test.describe("Load guardrails", () => {
  test.afterEach(async ({ page }) => {
    await Promise.race([
      clearTestDatabase(page),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Cleanup timeout")), 5000),
      ),
    ]).catch(() => {});
  });

  test("does not render text editor before delayed content load", async ({
    page,
  }) => {
    await setupTestDatabase(page, "load-guardrails-delay");
    await page.addInitScript(() => {
      (
        window as { __METRISTS_DEBUG_FILE_LOAD_DELAY_MS?: number }
      ).__METRISTS_DEBUG_FILE_LOAD_DELAY_MS = 2000;
      (
        window as { __METRISTS_DEBUG_FILE_LOAD_FAIL_MATCH?: string }
      ).__METRISTS_DEBUG_FILE_LOAD_FAIL_MATCH = "";
    });

    await openWorkspace(page, workspacePath);
    await seedTestFiles(page, [
      {
        path: guardedFilePath,
        content: originalContent,
        type: "file",
      },
    ]);

    await page.reload();
    await waitForFileTree(page, guardedFileName);
    await openFileInTree(page, guardedFileName);

    await expect(page.locator("text=Loading...")).toBeVisible();
    await expect(
      page.locator('[role="textbox"]').locator("visible=true"),
    ).toHaveCount(0);

    await expect
      .poll(async () => await getEditorContent(page), {
        timeout: 8000,
      })
      .toContain("Original content must remain intact.");
  });

  test("shows retryable error state and does not overwrite content on load failure", async ({
    page,
  }) => {
    await setupTestDatabase(page, "load-guardrails-error");
    await page.addInitScript(() => {
      (
        window as { __METRISTS_DEBUG_FILE_LOAD_DELAY_MS?: number }
      ).__METRISTS_DEBUG_FILE_LOAD_DELAY_MS = 0;
      (
        window as { __METRISTS_DEBUG_FILE_LOAD_FAIL_MATCH?: string }
      ).__METRISTS_DEBUG_FILE_LOAD_FAIL_MATCH = "guarded.md";
    });

    await openWorkspace(page, workspacePath);
    await seedTestFiles(page, [
      {
        path: guardedFilePath,
        content: originalContent,
        type: "file",
      },
    ]);

    await page.reload();
    await waitForFileTree(page, guardedFileName);
    await openFileInTree(page, guardedFileName);

    await expect(
      page
        .locator(`text=Failed to load file content for ${guardedFilePath}`)
        .first(),
    ).toBeVisible();
    await expect(page.locator('button:has-text("Retry")')).toBeVisible();
    await expect(
      page.locator('[role="textbox"]').locator("visible=true"),
    ).toHaveCount(0);

    const stored = await getIndexedDBContent(
      page,
      workspacePath,
      guardedFilePath,
    );
    expect(stored).toContain("Original content must remain intact.");
  });
});
