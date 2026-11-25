/**
 * MET-291: a file's context menu shows it in the system's file manager,
 * where the platform has one. The e2e page claims Windows, so the item reads
 * "Show in File Explorer".
 */
import { test, expect } from "@playwright/test";
import { openWorkspace, seedTestFiles, setupTestDatabase, waitForFileTree } from "../setup/test-helpers";

const WS = "/workspace/file-tree-reveal";

test("a file's context menu reveals it in the file manager, only where there is one", async ({ page }) => {
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
  await notes.click({ button: "right" });
  await reveal.click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __revealed: string[] }).__revealed)).toEqual([`${WS}/notes.md`]);
});
