import { expect, test, type Page } from "@playwright/test";
import {
  openFileInNewTab,
  openFileInTree,
  openWorkspace,
  seedTestFiles,
  setupTestDatabase,
  waitForFileTree,
} from "../setup/test-helpers";

const WORKSPACE_PATH = "/workspace/focus-management";

const focusFixtureFiles = [
  {
    path: `${WORKSPACE_PATH}/tab-a.md`,
    content: "alpha content for tab a",
    type: "file" as const,
  },
  {
    path: `${WORKSPACE_PATH}/tab-b.md`,
    content: "bravo content for tab b",
    type: "file" as const,
  },
  {
    path: `${WORKSPACE_PATH}/tab-c.md`,
    content: "charlie content for tab c",
    type: "file" as const,
  },
  {
    path: `${WORKSPACE_PATH}/tab-d.md`,
    content: "delta content for tab d",
    type: "file" as const,
  },
  {
    path: `${WORKSPACE_PATH}/rename-me.md`,
    content: "rename target",
    type: "file" as const,
  },
  {
    path: `${WORKSPACE_PATH}/notes.md`,
    content: "notes content",
    type: "file" as const,
  },
];

async function clickTab(page: Page, name: string) {
  const tabBar = page.locator('[data-testid="tab-bar"]');
  await tabBar.locator(`.cursor-pointer:has-text("${name}")`).first().click();
  await page.waitForTimeout(250);
}

async function isEditorFocused(page: Page) {
  return page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null;
    if (!active) return false;
    return !!active.closest('[role="textbox"]');
  });
}

async function openSettings(page: Page) {
  const settingsButton = page.getByRole("button", { name: "Settings" }).first();
  await settingsButton.click();
}

async function getWindowEditorText(page: Page, windowId: string) {
  const editor = page
    .locator(`[data-dockable-window-id="${windowId}"] [role="textbox"]`)
    .first();
  await expect(editor).toBeVisible();
  return (await editor.textContent()) ?? "";
}

test.describe("Focus Management", () => {
  test.beforeEach(async ({ page }) => {
    await setupTestDatabase(page, "focus-management");
    await openWorkspace(page, WORKSPACE_PATH);
    await seedTestFiles(page, focusFixtureFiles);
    await page.reload();
    await waitForFileTree(page, "tab-a.md");
  });

  test("context menu rename keeps input focus @smoke", async ({ page }) => {
    await page.getByRole("treeitem", { name: "rename-me.md" }).click({
      button: "right",
    });
    await page.locator('[role="menuitem"]:has-text("Rename")').click();

    // The inline rename input lives in the tree's shadow root; with search
    // disabled it is the only input inside file-tree-container.
    const renameInput = page.locator("file-tree-container input");
    await expect(renameInput).toBeVisible();
    await expect(renameInput).toBeFocused();

    // Input should stay focused long enough to type
    await page.waitForTimeout(250);
    await expect(renameInput).toBeFocused();

    await page.keyboard.press("Meta+a");
    await page.keyboard.type("renamed-focus.md");
    await expect(renameInput).toHaveValue("renamed-focus.md");
    await renameInput.press("Enter");

    await expect(
      page.getByRole("treeitem", { name: "renamed-focus.md" }),
    ).toBeVisible();
  });

  test("settings close restores editor focus", async ({ page }) => {
    await openFileInTree(page, "notes.md");

    await openSettings(page);
    const settingsDialog = page.getByRole("dialog");
    await expect(settingsDialog).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(settingsDialog).not.toBeVisible();

    await expect.poll(async () => isEditorFocused(page)).toBe(true);
  });

  test("multi-tab switching keeps independent editing context per editor", async ({
    page,
  }) => {
    await openFileInTree(page, "tab-a.md");
    await openFileInNewTab(page, "tab-b.md");

    await clickTab(page, "tab-a.md");
    const editor = page
      .locator('[role="textbox"]')
      .locator("visible=true")
      .first();
    await editor.click();
    await page.keyboard.press("Home");
    await page.keyboard.type("A-");

    await expect(editor).toContainText("A-alpha content for tab a");

    await clickTab(page, "tab-b.md");
    await editor.click();
    await page.keyboard.press("End");
    await page.keyboard.type("B");
    await expect(editor).toContainText("bravo content for tab b");
    await expect(editor).toContainText("B");

    // Typing without a click relies on the async tab-switch focus restore
    // (next-frame request + reclaim window) — wait for it, not for a clock.
    await clickTab(page, "tab-a.md");
    await expect(editor).toBeFocused();
    await page.keyboard.type("1");
    await expect(editor).toContainText("A-1alpha content for tab a");

    await clickTab(page, "tab-b.md");
    await expect(editor).toBeFocused();
    await page.keyboard.type("2");
    await expect(editor).toContainText("bravo content for tab b");
    await expect(editor).toContainText("B");
    await expect(editor).toContainText("2");

    await clickTab(page, "tab-a.md");
    await expect(editor).toContainText("A-1alpha content for tab a");
    await expect(editor).not.toContainText("bravo content for tab b");
  });

  test("new file opens an empty scratchpad showing the prompt widget first with its composer focused", async ({
    page,
  }) => {
    // "New File" is instant (MET-135): no naming prompt, the untitled
    // scratchpad opens straight into the empty-document prompt widget.
    await page.getByRole("button", { name: "New file" }).click();

    const widget = page
      .locator('[data-type="ai-prompt"]')
      .locator("visible=true")
      .first();
    await expect(widget).toBeVisible();

    // No blank line above the widget: it is the document's first block.
    // (The node view mounts inside an extra wrapper div, so walk up from
    // the widget to the .ProseMirror child instead of reading data-type
    // off firstElementChild directly.)
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const pm = document.querySelector(".ProseMirror");
          const widgetEl = pm?.querySelector('[data-type="ai-prompt"]');
          if (!pm || !widgetEl) return false;
          let block: Element = widgetEl;
          while (block.parentElement && block.parentElement !== pm) {
            block = block.parentElement;
          }
          return pm.firstElementChild === block;
        }),
      )
      .toBe(true);

    // The composer is the widget's draft, which is content of the
    // document's own editor — so "focused" means the document holds focus
    // with its caret in the draft, not that a second editor took it.
    const draft = widget.locator("[data-prompt-draft]").first();
    const caretIsInDraft = () =>
      page.evaluate(() => {
        const pm = document.querySelector(".ProseMirror");
        const node = window.getSelection()?.anchorNode ?? null;
        const element =
          node instanceof Element ? node : (node?.parentElement ?? null);
        return (
          document.activeElement === pm &&
          Boolean(element?.closest("[data-prompt-draft]"))
        );
      });
    await expect.poll(caretIsInDraft).toBe(true);

    // The editor's post-mount reclaim window is 600ms — focus must survive
    // it, not just land briefly.
    await page.waitForTimeout(800);
    expect(await caretIsInDraft()).toBe(true);

    // Typing goes to the draft, not the prose around it.
    await page.keyboard.type("hello agent");
    await expect(draft).toHaveText("hello agent");
  });

  test("multi-dock hotkeys switch tabs inside the active dock window", async ({
    page,
  }) => {
    const tabAPath = `${WORKSPACE_PATH}/tab-a.md`;
    const tabBPath = `${WORKSPACE_PATH}/tab-b.md`;
    const tabCPath = `${WORKSPACE_PATH}/tab-c.md`;
    const tabDPath = `${WORKSPACE_PATH}/tab-d.md`;

    const twoWindowLayout = [
      {
        type: "Panel",
        id: "panel-root",
        orientation: "row",
        size: 1,
        children: [
          {
            type: "Window",
            id: "window-left",
            children: [tabAPath, tabBPath],
            selected: tabAPath,
            size: 0.5,
          },
          {
            type: "Window",
            id: "window-right",
            children: [tabCPath, tabDPath],
            selected: tabCPath,
            size: 0.5,
          },
        ],
      },
    ];

    const encodedPath = encodeURIComponent(WORKSPACE_PATH);
    const encodedLayout = encodeURIComponent(JSON.stringify(twoWindowLayout));
    await page.goto(`/${encodedPath}?layout=${encodedLayout}`);
    await waitForFileTree(page, "tab-a.md");

    const rightEditor = page
      .locator('[data-dockable-window-id="window-right"] [role="textbox"]')
      .first();
    await rightEditor.click();

    await expect
      .poll(async () => getWindowEditorText(page, "window-right"))
      .toContain("charlie content for tab c");
    await expect
      .poll(async () => getWindowEditorText(page, "window-left"))
      .toContain("alpha content for tab a");

    await page.keyboard.press("Control+Tab");

    await expect
      .poll(async () => getWindowEditorText(page, "window-right"))
      .toContain("delta content for tab d");
    await expect
      .poll(async () => getWindowEditorText(page, "window-left"))
      .toContain("alpha content for tab a");

    const leftEditor = page
      .locator('[data-dockable-window-id="window-left"] [role="textbox"]')
      .first();
    await leftEditor.click();
    await page.keyboard.press("Control+Tab");

    await expect
      .poll(async () => getWindowEditorText(page, "window-left"))
      .toContain("bravo content for tab b");
    await expect
      .poll(async () => getWindowEditorText(page, "window-right"))
      .toContain("delta content for tab d");
  });
});
