import { test, expect, type Page } from "@playwright/test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openFileInNewTab, waitForAutoSave } from "../setup/test-helpers";

/**
 * Real-backend repro for the reported scratchpad lifecycle bug: close the
 * scratchpad tab, reopen the project, and the entry auto-open lands on a
 * path that errors with "No such file or directory (os error 2)". Runs
 * against the real Rust fs via the test-shim, on a real temp workspace.
 */
test.describe("shim: scratchpad close → reopen project", () => {
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
   * tab (matching the reported repro state) and close the scratchpad tab
   * via its ✕.
   */
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

  test("empty re-entry sweeps, renames, and auto-opens the leftover scratchpad", async ({
    page,
  }) => {
    test.setTimeout(90000);

    await openProject(page);
    const editor = visibleEditor(page);
    await editor.waitFor({ state: "visible", timeout: 15000 });
    await expect.poll(listScratchpads, { timeout: 10000 }).toContain(
      "untitled.md",
    );

    await closeScratchpadTab(page);
    // Author into the closed scratchpad from outside — deterministic, and
    // exactly the warm-session shape the reported bug needs (typing races
    // the prompt composer's autofocus, MET-100).
    await fs.writeFile(
      path.join(workspace, ".metrists", "scratchpads", "untitled.md"),
      "# Warm Session\n\nwarm body\n",
      "utf8",
    );

    // Empty the layout mid-session: delete README through the tree.
    await page
      .getByRole("treeitem", { name: "README.md", exact: true })
      .first()
      .click({ button: "right" });
    await page.locator('[role="menuitem"]:has-text("Delete")').click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Delete" })
      .click();
    await expect(page.getByText("No file selected")).toBeVisible({
      timeout: 10000,
    });

    // Re-enter with a bare saved URL and warm collections: the auto-open
    // must land in the RENAMED scratchpad, error-free.
    await page.goto("/welcome");
    await openProject(page);

    const reopened = visibleEditor(page);
    await reopened.waitFor({ state: "visible", timeout: 15000 });
    await expectNoLoadError(page);
    await expect(reopened).toContainText("warm body", { timeout: 10000 });
    // The entry sweep renamed the untitled file before opening it.
    await expect
      .poll(async () => (await listScratchpads()).join(","), { timeout: 10000 })
      .toMatch(/^warm-session-[a-z0-9]{4}\.md$/);
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

  test("empty entry auto-opens an existing scratchpad", async ({ page }) => {
    test.setTimeout(90000);

    await fs.mkdir(path.join(workspace, ".metrists", "scratchpads"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(workspace, ".metrists", "scratchpads", "my-notes-ab12.md"),
      "# My Notes\n\nexisting body\n",
      "utf8",
    );

    await openProject(page);

    const editor = visibleEditor(page);
    await editor.waitFor({ state: "visible", timeout: 15000 });
    await expectNoLoadError(page);
    await expect(editor).toContainText("existing body", { timeout: 10000 });
    // Reused, not duplicated: no fresh untitled file appears.
    expect(await listScratchpads()).toEqual(["my-notes-ab12.md"]);
  });

  test("content scratchpad survives close and reopens cleanly", async ({
    page,
  }) => {
    test.setTimeout(90000);

    // Fresh entry with nothing restored: the auto-open lands in a new
    // untitled scratchpad.
    await openProject(page);
    const editor = visibleEditor(page);
    await editor.waitFor({ state: "visible", timeout: 15000 });
    await expect.poll(listScratchpads, { timeout: 10000 }).toContain(
      "untitled.md",
    );

    await editor.click();
    await editor.pressSequentially("# Repro Notes", { delay: 10 });
    await page.keyboard.press("Enter");
    await editor.pressSequentially("body text", { delay: 10 });
    await waitForAutoSave(page);

    // Close the scratchpad tab (its title shows the derived heading).
    await closeScratchpadTab(page);

    // Reopen the project (bare-root entry, like picking it from recents).
    // README is still in the saved layout, so it restores; the entry sweep
    // renames the closed scratchpad, which must then open cleanly from the
    // tree — the reported bug was a "No such file or directory (os error
    // 2)" here.
    await page.goto("/welcome");
    await openProject(page);
    await visibleEditor(page).waitFor({ state: "visible", timeout: 15000 });
    await expectNoLoadError(page);
    await expect
      .poll(async () => (await listScratchpads()).join(","), { timeout: 10000 })
      .toMatch(/repro-notes-[a-z0-9]{4}\.md/);

    const [renamed] = await listScratchpads();
    await page.getByRole("treeitem", { name: /scratchpads/ }).click();
    await page.getByRole("treeitem", { name: renamed }).click();
    await expect(visibleEditor(page)).toContainText("body text", {
      timeout: 10000,
    });
    await expectNoLoadError(page);
  });

  test("empty scratchpad close → reopen creates a fresh one without errors", async ({
    page,
  }) => {
    test.setTimeout(90000);

    await openProject(page);
    const editor = visibleEditor(page);
    await editor.waitFor({ state: "visible", timeout: 15000 });
    await expect.poll(listScratchpads, { timeout: 10000 }).toContain(
      "untitled.md",
    );

    // Close it untouched; the leftover is swept at the next entry.
    await closeScratchpadTab(page);

    // Reopen: a fresh scratchpad must open with a working editor.
    await page.goto("/welcome");
    await openProject(page);

    const reopened = visibleEditor(page);
    await reopened.waitFor({ state: "visible", timeout: 15000 });
    await expectNoLoadError(page);
    await reopened.click();
    await reopened.pressSequentially("still alive", { delay: 10 });
    await expect(reopened).toContainText("still alive");
  });

  test("full reload after closing the scratchpad reopens cleanly", async ({
    page,
  }) => {
    test.setTimeout(90000);

    await openProject(page);
    const editor = visibleEditor(page);
    await editor.waitFor({ state: "visible", timeout: 15000 });
    await editor.click();
    await editor.pressSequentially("# Reload Case", { delay: 10 });
    await waitForAutoSave(page);

    await closeScratchpadTab(page);

    // App-relaunch equivalent: reload, then enter the project at bare root.
    await page.reload();
    await openProject(page);

    await visibleEditor(page).waitFor({ state: "visible", timeout: 15000 });
    await expectNoLoadError(page);
    // The entry sweep renamed the leftover; it opens cleanly from the tree.
    await expect
      .poll(async () => (await listScratchpads()).join(","), { timeout: 10000 })
      .toMatch(/reload-case-[a-z0-9]{4}\.md/);
    await page.getByRole("treeitem", { name: /scratchpads/ }).click();
    await page
      .getByRole("treeitem", { name: /reload-case-[a-z0-9]{4}\.md/ })
      .click();
    await expect(visibleEditor(page)).toContainText("Reload Case", {
      timeout: 10000,
    });
    await expectNoLoadError(page);
  });
});
