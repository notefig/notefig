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
      .readdir(path.join(workspace, ".notefig", "scratchpads"))
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
    await expect
      .poll(listScratchpads, { timeout: 10000 })
      .toContain("untitled.md");

    await editor.click();
    await editor.pressSequentially("still alive", { delay: 10 });
    await waitForAutoSave(page);
    const content = await fs.readFile(
      path.join(workspace, ".notefig", "scratchpads", "untitled.md"),
      "utf8",
    );
    expect(content).toContain("still alive");
  });

  test("empty entry auto-opens an existing scratchpad", async ({ page }) => {
    test.setTimeout(90000);

    await fs.mkdir(path.join(workspace, ".notefig", "scratchpads"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(workspace, ".notefig", "scratchpads", "my-notes.md"),
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

  test("empty entry auto-opens the most recent of SEVERAL scratchpads", async ({
    page,
  }) => {
    test.setTimeout(90000);

    // Two contentful renamed scratchpads — the compare loop in
    // pickMostRecentScratchpad only runs with 2+ candidates, which is where
    // the epoch-millis-vs-Date wire bug crashed entry resolution and left
    // the app stranded at the bare root.
    const dir = path.join(workspace, ".notefig", "scratchpads");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "older-notes.md"), "# Old\n\nold body\n");
    await fs.writeFile(path.join(dir, "newer-notes.md"), "# New\n\nnew body\n");
    const now = Date.now() / 1000;
    await fs.utimes(path.join(dir, "older-notes.md"), now - 3600, now - 3600);
    await fs.utimes(path.join(dir, "newer-notes.md"), now - 60, now - 60);

    await openProject(page);

    const editor = visibleEditor(page);
    await editor.waitFor({ state: "visible", timeout: 15000 });
    await expectNoLoadError(page);
    await expect(editor).toContainText("new body", { timeout: 10000 });
    expect((await listScratchpads()).sort()).toEqual([
      "newer-notes.md",
      "older-notes.md",
    ]);
  });

  test("re-entry after closing the last tab re-opens the renamed scratchpad", async ({
    page,
  }) => {
    test.setTimeout(90000);

    await fs.mkdir(path.join(workspace, ".notefig", "scratchpads"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(workspace, ".notefig", "scratchpads", "canto-notes.md"),
      "# Canto\n\nnotes body\n",
      "utf8",
    );

    await openProject(page);
    const editor = visibleEditor(page);
    await editor.waitFor({ state: "visible", timeout: 15000 });
    await expect(editor).toContainText("notes body", { timeout: 10000 });

    // Close the ONLY tab via the palette's Close File (a single-tab window
    // has no ✕): the project sits at its bare root with the empty state,
    // and that bare URL is recorded as the saved session.
    await editor.click();
    // Mod+P, not Mod+K (the focused Tiptap editor claims Mod+K for links);
    // Control, not Meta — the Desktop Chrome device UA claims Windows, so
    // the app's Mod resolves to Control here.
    await page.keyboard.press("Control+p");
    const palette = page.getByPlaceholder(/command/i);
    await palette.waitFor({ state: "visible", timeout: 5000 });
    await palette.fill("close file");
    await page.keyboard.press("Enter");
    await expect(page.getByText(/No file selected/)).toBeVisible({
      timeout: 10000,
    });
    await page.waitForTimeout(750);

    // Re-enter: the empty saved session must auto-open the scratchpad
    // again — this is the "come back to my scratchpad" loop.
    await page.goto("/welcome");
    await openProject(page);
    await expect(visibleEditor(page)).toContainText("notes body", {
      timeout: 15000,
    });
    await expectNoLoadError(page);
    // Reused, not duplicated.
    expect(await listScratchpads()).toEqual(["canto-notes.md"]);
  });

  test("entry sweep deletes abandoned empty scratchpads, keeps content", async ({
    page,
  }) => {
    test.setTimeout(90000);

    await openProject(page);
    const editor = visibleEditor(page);
    await editor.waitFor({ state: "visible", timeout: 15000 });
    await expect
      .poll(listScratchpads, { timeout: 10000 })
      .toContain("untitled.md");

    // Close it untouched; a second, contentful scratchpad stays on disk,
    // and so does an EMPTY but renamed one — a user-chosen name is intent,
    // never an abandoned leftover.
    await closeScratchpadTab(page);
    await fs.writeFile(
      path.join(workspace, ".notefig", "scratchpads", "untitled-2.md"),
      "# Keeper\n\nkept body\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(workspace, ".notefig", "scratchpads", "renamed-empty.md"),
      "",
      "utf8",
    );

    // Re-enter at the bare root: README restores, the empty untitled
    // leftover is swept, the contentful and the renamed-empty ones survive.
    await page.goto("/welcome");
    await openProject(page);
    await expect(visibleEditor(page)).toContainText("Seeded", {
      timeout: 15000,
    });
    await expectNoLoadError(page);
    await expect
      .poll(async () => (await listScratchpads()).sort().join(","), {
        timeout: 10000,
      })
      .toBe("renamed-empty.md,untitled-2.md");
  });
});
