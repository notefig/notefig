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
    await page.locator('button:has-text("rename-me.md")').first().click({
      button: "right",
    });
    await page.locator('[role="menuitem"]:has-text("Rename")').click();

    const renameInput = page.locator(
      'input[data-focus-key^="file-tree-rename-"]',
    );
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
      page.locator('button:has-text("renamed-focus.md")'),
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

    await clickTab(page, "tab-a.md");
    await page.keyboard.type("1");
    await expect(editor).toContainText("A-1alpha content for tab a");

    await clickTab(page, "tab-b.md");
    await page.keyboard.type("2");
    await expect(editor).toContainText("bravo content for tab b");
    await expect(editor).toContainText("B");
    await expect(editor).toContainText("2");

    await clickTab(page, "tab-a.md");
    await expect(editor).toContainText("A-1alpha content for tab a");
    await expect(editor).not.toContainText("bravo content for tab b");
  });

  test("creating a new file focuses the opened editor", async ({ page }) => {
    await page.getByRole("button", { name: "New file" }).click();

    const createInput = page.locator('input[placeholder="filename.md"]');
    await expect(createInput).toBeVisible();
    await expect(createInput).toBeFocused();

    await createInput.fill("focus-created-file.md");
    await createInput.press("Enter");

    await expect(
      page.locator('button:has-text("focus-created-file.md")'),
    ).toBeVisible();
    const editor = page
      .locator('[role="textbox"]')
      .locator("visible=true")
      .first();
    await editor.click();
    await expect.poll(async () => isEditorFocused(page)).toBe(true);

    await editor.pressSequentially("focused");
    await expect(editor).toContainText("focused");
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
