/**
 * MET-291: a file's context menu shows it in the system's file manager,
 * where the platform has one: in the file tree, and among the Everything
 * view's recent documents. The e2e page claims Windows, so the item reads
 * "Show in File Explorer".
 */
import { test, expect } from "@playwright/test";
import { openWorkspace, seedTestFiles, setupTestDatabase, waitForFileTree } from "../setup/test-helpers";

const WS = "/workspace/file-tree-reveal";

test("a file's context menus reveal it in the file manager, only where there is one", async ({ page }) => {
  await setupTestDatabase(page, "file-tree-reveal");
  await openWorkspace(page, WS);
  await seedTestFiles(page, [{ path: `${WS}/notes.md`, content: "Notes.\n", type: "file" }]);
  await page.reload();
  await waitForFileTree(page, "notes.md");
  const notes = page.getByRole("treeitem", { name: "notes.md" }).first();
  const reveal = page.getByRole("menuitem", { name: "Show in File Explorer" });

  // The web has no file manager: no item.
  await notes.click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Open in new tab" })).toBeVisible();
  await expect(reveal).toHaveCount(0);
  await page.keyboard.press("Escape");

  // A platform with one: the item hands it the file's absolute path.
  await page.evaluate(() => {
    const w = window as unknown as {
      __revealed: string[];
      __notefigCore: { platform: { ui: { revealInFolder?: (path: string) => Promise<void> } } };
    };
    w.__revealed = [];
    w.__notefigCore.platform.ui.revealInFolder = async (path) => void w.__revealed.push(path);
  });
  const revealed = () => page.evaluate(() => (window as unknown as { __revealed: string[] }).__revealed);
  await notes.click({ button: "right" });
  await reveal.click();
  await expect.poll(revealed).toEqual([`${WS}/notes.md`]);

  // Opened, it's a recent document in the Everything view, whose row offers
  // the same.
  await notes.click();
  await page.getByRole("button", { name: "Everything", exact: true }).click();
  await page.locator(`button[title^="${WS}/notes.md"]`).click({ button: "right" });
  await reveal.click();
  await expect.poll(revealed).toEqual([`${WS}/notes.md`, `${WS}/notes.md`]);
});
