/**
 * A diff block in a document (```ts diff=…, see @notefig/widgets/diff-block)
 * is drawn as its diff, shown as its source while the caret is in it, and
 * saved as the code block it is.
 */
import { test, expect } from "@playwright/test";
import {
  setupTestDatabase,
  openWorkspace,
  seedTestFiles,
  waitForFileTree,
  openFileInTree,
  waitForContentSaved,
} from "../setup/test-helpers";

const BLOCK = "```ts diff=src/greet.ts\nconst greeting = \"hi\";\n=======\nconst greeting = \"hello\";\n```";

test("a diff block is drawn as a diff, and edited as its source @smoke", async ({ page }) => {
  const workspace = "/workspace/diff-blocks";
  await setupTestDatabase(page, "diff-blocks");
  await openWorkspace(page, workspace);
  await seedTestFiles(page, [
    { path: `${workspace}/change.md`, content: `# Change\n\n${BLOCK}\n\nAfter.\n`, type: "file" },
  ]);
  await page.reload();
  await waitForFileTree(page, "change.md");
  await openFileInTree(page, "change.md");

  const editor = page.locator(".ProseMirror");
  const diff = editor.locator("notefig-diff-block diffs-container");
  const source = editor.locator("> pre");
  await expect(diff.locator("[data-title]")).toHaveText("src/greet.ts");
  await expect(diff.locator('[data-line-type="change-deletion"]:not([data-column-number])').first()).toContainText('"hi"');
  await expect(diff.locator('[data-line-type="change-addition"]:not([data-column-number])').first()).toContainText('"hello"');
  await expect(source).toBeHidden();

  // Side by side where there is room for both sides, one column where not.
  const layout = diff.locator("pre[data-diff-type]");
  await expect(layout).toHaveAttribute("data-diff-type", "split");
  const viewport = page.viewportSize()!;
  await page.setViewportSize({ width: 560, height: viewport.height });
  await expect(layout).toHaveAttribute("data-diff-type", "single");
  await page.setViewportSize(viewport);
  await expect(layout).toHaveAttribute("data-diff-type", "split");

  // The app's theme, not the OS's: the e2e browser prefers light.
  const title = diff.locator("[data-title]");
  await page.evaluate(() => document.documentElement.classList.add("dark"));
  await expect(title).toHaveCSS("color", "rgb(250, 250, 250)");
  await page.evaluate(() => document.documentElement.classList.remove("dark"));
  await expect(title).toHaveCSS("color", "rgb(10, 10, 10)");

  // A click on it is a way into its source.
  await diff.click();
  await expect(source).toBeVisible();
  await expect(diff).toHaveCount(0);
  await expect(source).toContainText("=======");

  // An edit there is drawn when the caret leaves.
  await page.keyboard.press("End");
  await page.keyboard.type(" // was hi");
  await editor.getByText("After.").click();
  await expect(source).toBeHidden();
  await expect(diff.locator('[data-line-type="change-deletion"]:not([data-column-number])').first()).toContainText("// was hi");
  await waitForContentSaved(
    page,
    `${workspace}/change.md`,
    "```ts diff=src/greet.ts\nconst greeting = \"hi\"; // was hi\n=======\nconst greeting = \"hello\";\n```",
  );
});
