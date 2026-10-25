/**
 * Kept tabs — a file tab stays mounted, hidden and inert, while another tab
 * in its window is selected (up to MAX_KEPT_TABS per window). These are the
 * ways a hidden editor could still act on, or be acted on by, what the user
 * does in the visible one.
 */
import { expect, test, type Page } from "@playwright/test";
import {
  openFileInNewTab,
  openFileInTree,
  openWorkspace,
  seedTestFiles,
  setupTestDatabase,
  waitForContentSaved,
  waitForFileTree,
} from "../setup/test-helpers";

const WORKSPACE_PATH = "/workspace/kept-tabs";

// One more filler than a window keeps, so the first tab is evicted.
const FILLERS = Array.from({ length: 8 }, (_, i) => `filler-${i + 1}.md`);

const fixtureFiles = [
  { path: `${WORKSPACE_PATH}/tab-a.md`, content: "alpha content" },
  { path: `${WORKSPACE_PATH}/tab-b.md`, content: "bravo content" },
  { path: `${WORKSPACE_PATH}/rename-me.md`, content: "rename target" },
  ...FILLERS.map((name) => ({
    path: `${WORKSPACE_PATH}/${name}`,
    content: `${name} content`,
  })),
].map((file) => ({ ...file, type: "file" as const }));

async function clickTab(page: Page, name: string) {
  const tabBar = page.locator('[data-testid="tab-bar"]');
  await tabBar.locator(`.cursor-pointer:has-text("${name}")`).first().click();
  await page.waitForTimeout(250);
}

/** The editor holding a document, hidden or not. */
const editorWith = (page: Page, text: string) =>
  page.locator('[role="textbox"]').filter({ hasText: text });

const visibleEditor = (page: Page) =>
  page.locator('[role="textbox"]').locator("visible=true").first();

/** The app's Mod key as the page sees it — the device profile reports
 *  Windows, so a host-resolved ControlOrMeta would miss its keymaps. */
async function press(page: Page, combo: string) {
  const isMac = await page.evaluate(() => navigator.platform.includes("Mac"));
  await page.keyboard.press(combo.replace("Mod", isMac ? "Meta" : "Control"));
}

async function typeAtEnd(page: Page, text: string) {
  await visibleEditor(page).click();
  await press(page, "Mod+End");
  await page.keyboard.type(text);
}

test.describe("kept tabs", () => {
  test.beforeEach(async ({ page }, testInfo) => {
    await setupTestDatabase(page, testInfo.title);
    await openWorkspace(page, WORKSPACE_PATH);
    await seedTestFiles(page, fixtureFiles);
    await page.reload();
    await waitForFileTree(page, "tab-a.md");
  });

  test("undo and redo act only on the visible document", async ({ page }) => {
    await openFileInTree(page, "tab-a.md");
    await typeAtEnd(page, " edited in A");
    await openFileInNewTab(page, "tab-b.md");
    await typeAtEnd(page, " edited in B");

    // B's undo leaves the hidden A alone, in the editor and on disk.
    await press(page, "Mod+z");
    await expect(visibleEditor(page)).toHaveText("bravo content");
    await expect(editorWith(page, "alpha")).toHaveText(
      "alpha content edited in A",
    );
    await waitForContentSaved(
      page,
      `${WORKSPACE_PATH}/tab-a.md`,
      "edited in A",
    );

    // A still has its own history to undo and redo.
    await clickTab(page, "tab-a.md");
    await expect(visibleEditor(page)).toBeFocused();
    await press(page, "Mod+z");
    await expect(visibleEditor(page)).toHaveText("alpha content");
    await press(page, "Mod+Shift+z");
    await expect(visibleEditor(page)).toHaveText("alpha content edited in A");
    await expect(editorWith(page, "bravo")).toHaveText("bravo content");
  });

  test("the browser's own undo never reaches a hidden document", async ({
    page,
  }) => {
    await openFileInTree(page, "tab-a.md");
    await openFileInNewTab(page, "tab-b.md");
    await typeAtEnd(page, " edited in B");
    await clickTab(page, "tab-a.md");
    await expect(visibleEditor(page)).toBeFocused();

    // A has nothing to undo, so its keymap passes ⌘Z on and the browser runs
    // its native undo (the macOS app: Edit ▸ Undo), which fires historyUndo
    // at the last contenteditable it saw edited — B, hidden. Sent directly:
    // which key reaches native undo depends on the host OS.
    await editorWith(page, "bravo").evaluate((editor) =>
      editor.dispatchEvent(
        new InputEvent("beforeinput", {
          inputType: "historyUndo",
          bubbles: true,
          cancelable: true,
        }),
      ),
    );

    await expect(editorWith(page, "bravo")).toHaveText(
      "bravo content edited in B",
    );
    await expect(visibleEditor(page)).toHaveText("alpha content");
  });

  test("a hidden editor gives up focus and never takes keystrokes", async ({
    page,
  }) => {
    await openFileInTree(page, "tab-a.md");
    await openFileInNewTab(page, "tab-b.md");
    await clickTab(page, "tab-a.md");
    await visibleEditor(page).click();

    // Switch by hotkey, so nothing but the switch itself moves focus.
    await page.keyboard.press("Control+Tab");
    await expect(visibleEditor(page)).toContainText("bravo content");
    expect(
      await page.evaluate(() => !!document.activeElement?.closest("[inert]")),
    ).toBe(false);

    await page.keyboard.type("XYZ");
    await expect(editorWith(page, "alpha")).toHaveText("alpha content");
  });

  test("a write to a hidden tab's file reaches its editor", async ({ page }) => {
    await openFileInTree(page, "tab-a.md");
    await openFileInNewTab(page, "tab-b.md");
    const hiddenA = editorWith(page, "alpha");
    await expect(hiddenA).toBeHidden();

    // Written through the files module, the way an agent's write lands
    // (this adapter has no watcher to report a change made on disk).
    await page.evaluate(
      ({ workspace, file }) =>
        (window as any).__notefigCore
          .workspace(workspace)
          .files.file(file)
          .write("alpha rewritten outside the editor"),
      { workspace: WORKSPACE_PATH, file: `${WORKSPACE_PATH}/tab-a.md` },
    );

    // Adopted while still hidden, not on the way back.
    await expect(hiddenA).toHaveText("alpha rewritten outside the editor");
    await clickTab(page, "tab-a.md");
    await expect(visibleEditor(page)).toHaveText(
      "alpha rewritten outside the editor",
    );
  });

  test("a tab evicted from the kept set keeps its caret and undo history", async ({
    page,
  }) => {
    await openFileInTree(page, "tab-a.md");
    await typeAtEnd(page, " typed before eviction");

    for (const name of FILLERS) await openFileInNewTab(page, name);
    // Unmounted: its document is no longer in the page at all.
    await expect(editorWith(page, "typed before eviction")).toHaveCount(0);

    await clickTab(page, "tab-a.md");
    const editor = visibleEditor(page);
    await expect(editor).toBeFocused();
    expect(
      await page.evaluate(() => {
        const selection = window.getSelection();
        return selection?.anchorNode?.textContent?.slice(
          0,
          selection.anchorOffset,
        );
      }),
    ).toBe("alpha content typed before eviction");

    await press(page, "Mod+z");
    await expect(editor).toHaveText("alpha content");
  });

  test("renaming a file whose tab is hidden keeps the tab working", async ({
    page,
  }) => {
    await openFileInTree(page, "rename-me.md");
    await openFileInNewTab(page, "tab-b.md");

    await page.getByRole("treeitem", { name: "rename-me.md" }).click({
      button: "right",
    });
    await page.locator('[role="menuitem"]:has-text("Rename")').click();
    const renameInput = page.locator("file-tree-container input");
    await expect(renameInput).toBeFocused();
    await page.keyboard.press("Meta+a");
    await page.keyboard.type("renamed.md");
    await renameInput.press("Enter");

    await clickTab(page, "renamed.md");
    await expect(visibleEditor(page)).toHaveText("rename target");
    await typeAtEnd(page, " after rename");
    await waitForContentSaved(
      page,
      `${WORKSPACE_PATH}/renamed.md`,
      "rename target after rename",
    );
  });

  test("a selection left in a hidden tab does not seed find", async ({
    page,
  }) => {
    await openFileInTree(page, "tab-a.md");
    await openFileInNewTab(page, "tab-b.md");
    await clickTab(page, "tab-a.md");
    await visibleEditor(page).click();
    await press(page, "Mod+a");

    await clickTab(page, "tab-b.md");
    await visibleEditor(page).click();
    await press(page, "Mod+f");

    const input = page.getByPlaceholder(/search/i).first();
    await expect(input).toBeVisible();
    await expect(input).toHaveValue("");
  });
});
