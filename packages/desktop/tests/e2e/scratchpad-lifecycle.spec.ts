import { test, expect, type Page } from "@playwright/test";
import {
  setupTestDatabase,
  seedTestFiles,
  openWorkspace,
  waitForFileTree,
  openFileInNewTab,
  waitForAutoSave,
  listScratchpadFiles,
} from "../setup/test-helpers";

/**
 * Browser-adapter twin of tests/shim/scratchpad-lifecycle.spec.ts: the
 * reported close-scratchpad → reopen-project flow must not surface a
 * not-found error in web mode either.
 */
test.describe("scratchpad close → reopen project", () => {
  const ws = "/workspace/scratchpad-lifecycle";

  test.beforeEach(async ({ page }) => {
    await setupTestDatabase(page, "scratchpad-lifecycle");
    // Seed from a route with no workspace mounted, so the entry auto-open
    // can't navigate mid-seed.
    await page.goto("/welcome");
    await seedTestFiles(page, [
      { path: `${ws}/README.md`, content: "# Seeded\n", type: "file" },
    ]);
    await openWorkspace(page, ws);
    await waitForFileTree(page, "README.md");
  });

  function visibleEditor(page: Page) {
    return page.locator('[role="textbox"]').locator("visible=true").first();
  }

  async function expectNoLoadError(page: Page) {
    await expect(
      page.getByText(/could not be found|os error|No such file/i),
    ).toHaveCount(0);
  }

  /** Basename of the scratchpad holding `needle` (names are generated, so
   * find the file by its content, never by list position). */
  async function scratchpadBasenameContaining(
    page: Page,
    needle: string,
  ): Promise<string> {
    await expect
      .poll(async () =>
        (await listScratchpadFiles(page, ws)).some(({ content }) =>
          content.includes(needle),
        ),
      )
      .toBe(true);
    const files = await listScratchpadFiles(page, ws);
    const match = files.find(({ content }) => content.includes(needle));
    return match!.path.split("/").pop() as string;
  }

  /** The tree opens the scratchpads folder by default; that expansion
   * lands when the tree model first loads, so wait for it instead of
   * toggling — a click racing the default reset collapses the row. */
  async function expandScratchpadsRow(page: Page) {
    await expect(
      page.getByRole("treeitem", { name: /scratchpads/ }).first(),
    ).toHaveAttribute("aria-expanded", "true", { timeout: 10000 });
  }

  async function closeScratchpadTab(page: Page) {
    await openFileInNewTab(page, "README.md");
    const tab = page
      .getByRole("button", { name: /Close tab/ })
      .filter({ hasNotText: "README.md" })
      .first();
    await tab.hover();
    await tab.getByLabel("Close tab").click();
    await expect(tab).toHaveCount(0);
  }

  test("content scratchpad survives close and reopens from the tree", async ({
    page,
  }) => {
    const editor = visibleEditor(page);
    await editor.waitFor({ state: "visible", timeout: 15000 });
    await editor.click();
    await editor.pressSequentially("# Repro Notes", { delay: 10 });
    await page.keyboard.press("Enter");
    await editor.pressSequentially("body text", { delay: 10 });
    await expect(
      page.getByRole("heading", { name: "Repro Notes" }),
    ).toBeVisible();
    await waitForAutoSave(page);

    const basename = await scratchpadBasenameContaining(page, "body text");
    await closeScratchpadTab(page);

    await page.goto("/welcome");
    await openWorkspace(page, ws);
    await visibleEditor(page).waitFor({ state: "visible", timeout: 15000 });
    await expectNoLoadError(page);

    // The contentful scratchpad kept its name and survived the entry
    // sweep; it must open cleanly from the tree.
    await expandScratchpadsRow(page);
    await page.getByRole("treeitem", { name: basename }).click();
    await expect(visibleEditor(page)).toContainText("body text", {
      timeout: 10000,
    });
    await expectNoLoadError(page);
  });

  test("empty scratchpad close → reopen creates a fresh one without errors", async ({
    page,
  }) => {
    const editor = visibleEditor(page);
    await editor.waitFor({ state: "visible", timeout: 15000 });

    await closeScratchpadTab(page);

    // Only README remains in the layout; drop it so the next entry is empty.
    await page.goto("/welcome");
    await openWorkspace(page, ws);
    await visibleEditor(page).waitFor({ state: "visible", timeout: 15000 });
    await expectNoLoadError(page);
    await visibleEditor(page).click();
    await visibleEditor(page).pressSequentially("still alive", { delay: 10 });
    await expect(visibleEditor(page)).toContainText("still alive");
  });

  test("renaming an open file via the tree keeps its tab", async ({ page }) => {
    const editor = visibleEditor(page);
    await editor.waitFor({ state: "visible", timeout: 15000 });
    await editor.click();
    await editor.pressSequentially("# Repro Notes", { delay: 10 });
    await waitForAutoSave(page);

    const basename = await scratchpadBasenameContaining(page, "Repro Notes");
    await expandScratchpadsRow(page);
    const row = page.locator(`[data-item-path$="${basename}"]`);
    await row.click({ button: "right" });
    await page.getByText("Rename", { exact: true }).click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type("mynotes.md");
    await page.keyboard.press("Enter");

    // The tab follows the file: the layout swaps to the new id instead of
    // the stale-tab pruner closing it (the guard must outlast the
    // URL-driven layout commit, not a timer).
    await expect
      .poll(() => decodeURIComponent(page.url()), { timeout: 10000 })
      .toContain("mynotes.md");
    await expect(visibleEditor(page)).toContainText("Repro Notes", {
      timeout: 10000,
    });
    await expectNoLoadError(page);
  });
});
