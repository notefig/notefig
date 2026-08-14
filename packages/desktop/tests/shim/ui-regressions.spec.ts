import { test, expect } from "@playwright/test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  waitForFileTree,
  openWorkspace,
  openFileInTree,
} from "../setup/test-helpers";

/**
 * Regression coverage on the real backend for two file-tree/editor bugs:
 *
 * MET-130 — deleted files stayed visible in the tree: the old reconcile
 * diff kept a mirror that went permanently stale when its batch threw. The
 * nasty ordering is a sibling sorting BETWEEN a directory and its children
 * ("docs.md" lands between "docs" and "docs/a.md"), which is exactly the
 * shape seeded here.
 *
 * MET-131 — clicking the spacing around the prose column moved the cursor
 * to the end of the file and yanked the scroll position along with it.
 */
test.describe("shim: file tree deletion and editor gutter clicks", () => {
  let workspace = "";

  test.beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "metrists-shim-"));
    await fs.mkdir(path.join(workspace, "docs"));
    await fs.writeFile(path.join(workspace, "docs", "a.md"), "# A\n");
    await fs.writeFile(path.join(workspace, "docs.md"), "# Docs\n");
    await fs.writeFile(
      path.join(workspace, "long.md"),
      Array.from(
        { length: 80 },
        (_, i) => `Paragraph ${i + 1} of the long document.`,
      ).join("\n\n") + "\n",
    );
  });

  test.afterEach(async () => {
    if (workspace) await fs.rm(workspace, { recursive: true, force: true });
  });

  test("deleting a directory with an in-between sibling removes it from the tree (MET-130)", async ({
    page,
  }) => {
    test.setTimeout(60000);

    await openWorkspace(page, workspace);
    await waitForFileTree(page, "docs.md");
    await expect(
      page.getByRole("treeitem", { name: "docs", exact: true }).first(),
    ).toBeVisible();

    // Delete the docs directory through the UI (context menu → confirm).
    await page
      .getByRole("treeitem", { name: "docs", exact: true })
      .first()
      .click({ button: "right" });
    await page.locator('[role="menuitem"]:has-text("Delete")').click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Delete" })
      .click();

    // The directory row disappears; the in-between sibling file stays.
    await expect(
      page.getByRole("treeitem", { name: "docs", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("treeitem", { name: "docs.md", exact: true }).first(),
    ).toBeVisible();

    // Ground truth: the directory is gone from the real filesystem.
    await expect
      .poll(() =>
        fs.access(path.join(workspace, "docs")).then(
          () => "present",
          () => "gone",
        ),
      )
      .toBe("gone");

    // A plain file delete disappears from the tree too.
    await page
      .getByRole("treeitem", { name: "docs.md", exact: true })
      .first()
      .click({ button: "right" });
    await page.locator('[role="menuitem"]:has-text("Delete")').click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Delete" })
      .click();
    await expect(
      page.getByRole("treeitem", { name: "docs.md", exact: true }),
    ).toHaveCount(0);
  });

  test("clicking the editor gutter never scrolls or jumps the caret to the end (MET-131)", async ({
    page,
  }) => {
    test.setTimeout(60000);

    await openWorkspace(page, workspace);
    await waitForFileTree(page, "long.md");
    await openFileInTree(page, "long.md");

    const wrapper = page.locator(".tiptap-editor-wrapper:visible").first();
    await wrapper.waitFor();

    // The document is long enough to scroll; we sit at the top.
    const metrics = await wrapper.evaluate((el) => {
      el.scrollTop = 0;
      const prose = el.querySelector(".prose")!.getBoundingClientRect();
      const wrapperRect = el.getBoundingClientRect();
      return {
        scrollable: el.scrollHeight - el.clientHeight,
        proseLeft: prose.left,
        wrapperTop: wrapperRect.top,
        wrapperHeight: el.clientHeight,
      };
    });
    expect(metrics.scrollable).toBeGreaterThan(200);

    // Click in the side gutter (left of the centered prose column), halfway
    // down the visible viewport.
    await page.mouse.click(
      metrics.proseLeft - 40,
      metrics.wrapperTop + metrics.wrapperHeight / 2,
    );

    // The viewport must not move (the old fallback focused the document end,
    // which scrolled to the bottom).
    await page.waitForTimeout(300);
    expect(await wrapper.evaluate((el) => el.scrollTop)).toBe(0);

    // The caret landed near the click, not at the end: the last paragraph is
    // not the selection anchor.
    const caretText = await page.evaluate(() => {
      const sel = window.getSelection();
      return sel?.anchorNode?.textContent ?? "";
    });
    expect(caretText).not.toContain("Paragraph 80");
  });
});
