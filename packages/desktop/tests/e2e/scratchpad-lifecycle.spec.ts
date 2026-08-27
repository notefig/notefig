import { test, expect, type Page } from "@playwright/test";
import {
  setupTestDatabase,
  seedTestFiles,
  openWorkspace,
  waitForFileTree,
  openFileInNewTab,
  waitForAutoSave,
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

  async function closeScratchpadTab(page: Page) {
    await openFileInNewTab(page, "README.md");
    // The scratchpad tab is whichever tab isn't README (its title derives
    // from content and the composer can steal early keystrokes — MET-100).
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

    await closeScratchpadTab(page);

    await page.goto("/welcome");
    await openWorkspace(page, ws);
    await visibleEditor(page).waitFor({ state: "visible", timeout: 15000 });
    await expectNoLoadError(page);

    // The close-time rename produced a slug-named file; it must open
    // cleanly from the tree (the reported bug: not-found on open).
    await page.getByRole("treeitem", { name: /scratchpads/ }).click();
    await page
      .getByRole("treeitem", { name: /repro-notes-[a-z0-9]{4}\.md/ })
      .click();
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
});
