import { test, expect, type Page } from "@playwright/test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openFileInNewTab, waitForAutoSave } from "../setup/test-helpers";

/**
 * Real-backend coverage of the scratchpads' only special powers: "New
 * File"/empty entry auto-creates an untitled file in the folder, an empty
 * entry auto-opens the most recent one, and the entry sweep deletes
 * abandoned empty ones. Runs against the real Rust fs via the test-shim,
 * on a real temp workspace.
 */
test.describe("shim: scratchpad entry lifecycle", () => {
  let workspace = "";

  test.beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "metrists-shim-"));
    await fs.writeFile(path.join(workspace, "README.md"), "# Seeded\n", "utf8");
  });

  test.afterEach(async () => {
    if (workspace) await fs.rm(workspace, { recursive: true, force: true });
  });

  async function openProject(page: Page) {
    await page.goto(`/${encodeURIComponent(workspace)}`);
  }

  function visibleEditor(page: Page) {
    return page.locator('[role="textbox"]').locator("visible=true").first();
  }

  async function expectNoLoadError(page: Page) {
    await expect(page.getByText(/os error|No such file/i)).toHaveCount(0);
  }

  async function listScratchpads(): Promise<string[]> {
    return fs
      .readdir(path.join(workspace, ".metrists", "scratchpads"))
      .catch(() => [] as string[]);
  }

  /**
   * A single-tab window renders no tab strip, so open README in a second
   * tab and close the scratchpad tab via its ✕.
   */
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

  test("empty entry auto-creates and opens untitled.md", async ({ page }) => {
    test.setTimeout(90000);

    await openProject(page);
    const editor = visibleEditor(page);
    await editor.waitFor({ state: "visible", timeout: 15000 });
    await expectNoLoadError(page);
    await expect.poll(listScratchpads, { timeout: 10000 }).toContain(
      "untitled.md",
    );

    await editor.click();
    await editor.pressSequentially("still alive", { delay: 10 });
    await waitForAutoSave(page);
    const content = await fs.readFile(
      path.join(workspace, ".metrists", "scratchpads", "untitled.md"),
      "utf8",
    );
    expect(content).toContain("still alive");
  });

  test("empty entry auto-opens an existing scratchpad", async ({ page }) => {
    test.setTimeout(90000);

    await fs.mkdir(path.join(workspace, ".metrists", "scratchpads"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(workspace, ".metrists", "scratchpads", "my-notes.md"),
      "# My Notes\n\nexisting body\n",
      "utf8",
    );

    await openProject(page);

    const editor = visibleEditor(page);
    await editor.waitFor({ state: "visible", timeout: 15000 });
    await expectNoLoadError(page);
    await expect(editor).toContainText("existing body", { timeout: 10000 });
    // Reused, not duplicated: no fresh untitled file appears.
    expect(await listScratchpads()).toEqual(["my-notes.md"]);
  });

  test("re-entry with a saved layout never summons a scratchpad over it", async ({
    page,
  }) => {
    test.setTimeout(90000);

    // First entry auto-opens a scratchpad; replace it with README so the
    // saved layout holds a real file.
    await openProject(page);
    await visibleEditor(page).waitFor({ state: "visible", timeout: 15000 });
    await page.getByRole("treeitem", { name: "README.md" }).first().click();
    await expect(visibleEditor(page)).toContainText("Seeded", {
      timeout: 10000,
    });
    // The saved-URL record is written fire-and-forget; give it a beat to
    // land before the full navigation discards in-flight KV writes.
    await page.waitForTimeout(750);

    // Re-enter at the bare root: the saved layout must restore intact —
    // the auto-open must not race the restore and clobber it.
    await page.goto("/welcome");
    await openProject(page);

    await expect(visibleEditor(page)).toContainText("Seeded", {
      timeout: 15000,
    });
    await expectNoLoadError(page);
    await expect(
      page.getByRole("button", { name: /untitled.*Close tab/ }),
    ).toHaveCount(0);
  });

  test("entry sweep deletes abandoned empty scratchpads, keeps content", async ({
    page,
  }) => {
    test.setTimeout(90000);

    await openProject(page);
    const editor = visibleEditor(page);
    await editor.waitFor({ state: "visible", timeout: 15000 });
    await expect.poll(listScratchpads, { timeout: 10000 }).toContain(
      "untitled.md",
    );

    // Close it untouched; a second, contentful scratchpad stays on disk.
    await closeScratchpadTab(page);
    await fs.writeFile(
      path.join(workspace, ".metrists", "scratchpads", "untitled-2.md"),
      "# Keeper\n\nkept body\n",
      "utf8",
    );

    // Re-enter at the bare root: README restores, the empty leftover is
    // swept, the contentful one survives untouched.
    await page.goto("/welcome");
    await openProject(page);
    await expect(visibleEditor(page)).toContainText("Seeded", {
      timeout: 15000,
    });
    await expectNoLoadError(page);
    await expect
      .poll(async () => (await listScratchpads()).join(","), { timeout: 10000 })
      .toBe("untitled-2.md");
  });
});
