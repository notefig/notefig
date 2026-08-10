/**
 * Search → go-to-location through the FULL app: workspace boot, tab
 * layout, editor mount lifecycle. The component-level harness tests
 * (tests/editor) cover position resolution; these cover what the harness
 * can't — the mount/remount machinery that runs after navigation
 * (saved-selection restore, focus arbitration, cold-mount timing).
 */
import { test, expect, type Page } from "@playwright/test";
import {
  setupTestDatabase,
  seedTestFiles,
  waitForFileTree,
  openWorkspace,
} from "../setup/test-helpers";
import { openFileInTree } from "../setup/test-helpers";

const WS = "/search-nav-ws";

const RICH_DOC = [
  "# Notes",
  "",
  "The first needle sits here.",
  "",
  "```js",
  "const app = start();",
  "```",
  "",
  "| Key | Value |",
  "| --- | ----- |",
  "| a   | 1     |",
  "",
  "The second needle sits here.",
  "",
  "The third needle sits here.",
  "",
].join("\n");

const OTHER_DOC = [
  "# Other",
  "",
  "Filler paragraph before.",
  "",
  "A remote needle lives in this file.",
  "",
].join("\n");

async function bootWorkspace(page: Page, testName: string) {
  await setupTestDatabase(page, testName);
  await openWorkspace(page, WS);
  await seedTestFiles(page, [
    { path: `${WS}/rich.md`, content: RICH_DOC },
    { path: `${WS}/other.md`, content: OTHER_DOC },
  ]);
  await page.reload();
  await waitForFileTree(page);
}

async function searchAndClick(page: Page, query: string, rowText: string) {
  await page.getByRole("button", { name: "Search" }).click();
  const input = page.getByPlaceholder(/search/i).first();
  await input.fill(query);
  // Scope to the result rows (buttons) so we never hit the editor's copy.
  await page.locator("button", { hasText: rowText }).first().click();
}

function domSelection(page: Page) {
  return page.evaluate(() => {
    const sel = window.getSelection();
    return {
      text: sel?.toString() ?? "",
      block: sel?.anchorNode?.parentElement?.closest("p")?.textContent ?? "",
    };
  });
}

test.describe("search navigation (full app)", () => {
  test("match in the open document survives the tab remount", async ({
    page,
  }) => {
    await bootWorkspace(page, "search-nav-open-doc");
    await openFileInTree(page, "rich.md");
    await expect(page.locator(".ProseMirror").first()).toBeVisible();

    // Park the caret somewhere real first — this is the selection the
    // mount lifecycle will try to restore over the navigation.
    await page.locator(".ProseMirror h1").first().click();

    await searchAndClick(page, "needle", "The second needle sits here.");

    await expect
      .poll(() => domSelection(page), { timeout: 5_000 })
      .toEqual({
        text: "needle",
        block: "The second needle sits here.",
      });
  });

  test("match in a background tab survives the stale-selection restore", async ({
    page,
  }) => {
    await bootWorkspace(page, "search-nav-background-tab");

    // Open rich.md, park a caret in it, then switch away so its instance
    // stays registered with a saved selection while another tab is active.
    await openFileInTree(page, "rich.md");
    await expect(page.locator(".ProseMirror").first()).toBeVisible();
    await page.locator(".ProseMirror h1").first().click();
    await openFileInTree(page, "other.md");
    await expect(
      page.locator(".ProseMirror h1", { hasText: "Other" }),
    ).toBeVisible();

    // Navigation resolves against the still-registered background editor
    // immediately; the remount that follows must not clobber it by
    // restoring the saved caret from before the tab switch.
    await searchAndClick(page, "needle", "The third needle sits here.");

    await expect
      .poll(() => domSelection(page), { timeout: 5_000 })
      .toEqual({
        text: "needle",
        block: "The third needle sits here.",
      });
  });

  test("match in a not-yet-opened file lands after the cold mount", async ({
    page,
  }) => {
    await bootWorkspace(page, "search-nav-cold-mount");
    await openFileInTree(page, "rich.md");
    await expect(page.locator(".ProseMirror").first()).toBeVisible();

    await searchAndClick(page, "remote", "A remote needle lives in this file.");

    await expect
      .poll(() => domSelection(page), { timeout: 5_000 })
      .toEqual({
        text: "remote",
        block: "A remote needle lives in this file.",
      });
  });
});
