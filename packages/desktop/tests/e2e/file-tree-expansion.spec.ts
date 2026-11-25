/**
 * MET-252: a save that moves a file above an open folder, in date-modified
 * order, leaves the folder open. Sending a prompt from a widget saves its
 * document, which is how it was found.
 */
import { test, expect } from "@playwright/test";
import { openFileInTree, openWorkspace, seedTestFiles, setupTestDatabase, waitForFileTree } from "../setup/test-helpers";

const WS = "/workspace/file-tree-expansion";

test("a save in date-modified order keeps an open folder open", async ({ page }) => {
  await setupTestDatabase(page, "file-tree-expansion");
  await openWorkspace(page, WS);
  await seedTestFiles(page, [
    { path: `${WS}/docs/inner.md`, content: "Inner.\n", type: "file" },
    { path: `${WS}/notes.md`, content: "Notes.\n", type: "file" },
  ]);
  await page.goto("/?sort=date-modified&sidebarView=files");
  await waitForFileTree(page, "notes.md");
  const docs = page.getByRole("treeitem", { name: "docs" }).first();
  if ((await docs.getAttribute("aria-expanded")) !== "true") await docs.click();
  await expect(docs).toHaveAttribute("aria-expanded", "true");

  await openFileInTree(page, "notes.md");
  await page.locator(".ProseMirror").locator("visible=true").first().click();
  await page.keyboard.type(" Edited.");

  // Saved, it's the newest file: listed above docs, which stays open.
  const rows = () => page.locator("[data-item-path]").evaluateAll((els) => els.map((el) => el.getAttribute("data-item-path")));
  await expect.poll(async () => (await rows()).filter((path) => path === "docs/" || path === "notes.md")).toEqual(["notes.md", "docs/"]);
  await expect(docs).toHaveAttribute("aria-expanded", "true");
});
