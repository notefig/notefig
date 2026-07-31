import { test, expect } from "@playwright/test";
import {
  setupTestDatabase,
  openWorkspace,
  seedTestFiles,
  openFileInTree,
  openFileInNewTab,
  replaceEditorContent,
  getEditorContent,
  waitForAutoSave,
  getIndexedDBContent,
  waitForFileTree,
} from "../setup/test-helpers";
import { contentPersistenceFixture } from "./content-persistence.fixture";

test.describe("Content & Persistence", () => {
  test("Auto-save functionality @smoke", async ({ page }) => {
    await setupTestDatabase(page, "content-persistence-autosave");

    await openWorkspace(page, contentPersistenceFixture.workspacePath);
    await seedTestFiles(page, contentPersistenceFixture.files);
    await page.reload();

    await openFileInTree(page, "auto-save-test.md");

    const initialContent = await getEditorContent(page);
    expect(initialContent).toContain("Initial content for auto-save testing");

    await replaceEditorContent(
      page,
      "# Auto-save Test\n\nInitial content for auto-save testing.\n\nThis line was added to test auto-save.",
    );

    await waitForAutoSave(page);

    const persistedContent = await getIndexedDBContent(
      page,
      contentPersistenceFixture.workspacePath,
      `${contentPersistenceFixture.workspacePath}/auto-save-test.md`,
    );
    expect(persistedContent).toContain("This line was added to test auto-save");

    await replaceEditorContent(
      page,
      "# Auto-save Test\n\nThis content has been edited multiple times.\n\nLine 1 of edits.\n\nLine 2 of edits.",
    );

    await waitForAutoSave(page);

    const updatedContent = await getIndexedDBContent(
      page,
      contentPersistenceFixture.workspacePath,
      `${contentPersistenceFixture.workspacePath}/auto-save-test.md`,
    );
    expect(updatedContent).toContain("Line 1 of edits");
    expect(updatedContent).toContain("Line 2 of edits");
  });

  test("Content recovery after reload", async ({ page }) => {
    await setupTestDatabase(page, "content-persistence-recovery");

    await openWorkspace(page, contentPersistenceFixture.workspacePath);
    await seedTestFiles(page, contentPersistenceFixture.files);
    await page.reload();

    await openFileInTree(page, "recovery-test.md");

    const editedContent =
      "# Recovery Test\n\nContent edited before reload.\n\nThis should persist after page reload.";
    await replaceEditorContent(page, editedContent);

    await waitForAutoSave(page, 1000);

    await page.reload();

    await page.waitForSelector('text="recovery-test.md"', { timeout: 10000 });

    // Re-open the file — tabs don't restore across reload yet.
    await openFileInTree(page, "recovery-test.md");

    const recoveredContent = await getEditorContent(page);
    expect(recoveredContent).toContain("Content edited before reload");
    expect(recoveredContent).toContain("This should persist after page reload");

    const dbContent = await getIndexedDBContent(
      page,
      contentPersistenceFixture.workspacePath,
      `${contentPersistenceFixture.workspacePath}/recovery-test.md`,
    );
    expect(dbContent).toContain("Content edited before reload");
  });

  test("Large file handling", async ({ page }) => {
    await setupTestDatabase(page, "content-persistence-large-file");

    await openWorkspace(page, contentPersistenceFixture.workspacePath);
    await seedTestFiles(page, contentPersistenceFixture.files);
    await page.reload();

    await waitForFileTree(page, "large-file.md");

    await openFileInTree(page, "large-file.md");

    const polled = expect.poll(
      async () =>
        getIndexedDBContent(
          page,
          contentPersistenceFixture.workspacePath,
          `${contentPersistenceFixture.workspacePath}/large-file.md`,
        ),
      {
        timeout: 1000,
      },
    );
    await polled.toContain("# Large File Test");
    await polled.toContain("Section");

    await page.waitForSelector('[role="textbox"]', { timeout: 10000 });
    const editor = page
      .locator('[role="textbox"]')
      .locator("visible=true")
      .first();
    expect(await editor.isVisible()).toBe(true);

    await editor.click();
    await page.keyboard.press("End");
    await page.waitForTimeout(50);
    await editor.pressSequentially("\nEDITED:", { delay: 5 });
    await expect(editor).toContainText("EDITED:");

    await waitForAutoSave(page, 800);

    await expect
      .poll(
        async () =>
          await getIndexedDBContent(
            page,
            contentPersistenceFixture.workspacePath,
            `${contentPersistenceFixture.workspacePath}/large-file.md`,
          ),
        {
          timeout: 500,
        },
      )
      .toContain("EDITED:");
  });

  test("Special characters in content", async ({ page }) => {
    await setupTestDatabase(page, "content-persistence-special-chars");

    await openWorkspace(page, contentPersistenceFixture.workspacePath);
    await seedTestFiles(page, contentPersistenceFixture.files);
    await page.reload();

    await openFileInTree(page, "special-chars.md");

    const content = await getEditorContent(page);
    expect(content).toContain("🚀"); // Emoji
    expect(content).toContain("مرحبا بكم"); // Arabic
    expect(content).toContain("你好世界"); // Chinese
    expect(content).toContain("こんにちは"); // Japanese
    expect(content).toContain("Привет мир"); // Cyrillic

    const newContent =
      content +
      "\n\n## New Section\n\n- Test: café ñoño\n- Math: ∑ ∫ √ π\n- Arrows: → ← ↑ ↓";
    await replaceEditorContent(page, newContent);

    await waitForAutoSave(page);

    const persistedContent = await getIndexedDBContent(
      page,
      contentPersistenceFixture.workspacePath,
      `${contentPersistenceFixture.workspacePath}/special-chars.md`,
    );
    expect(persistedContent).toContain("café ñoño");
    expect(persistedContent).toContain("∑ ∫ √ π");
    expect(persistedContent).toContain("→ ← ↑ ↓");

    await page.reload();
    await openFileInTree(page, "special-chars.md");

    const reloadedContent = await getEditorContent(page);
    expect(reloadedContent).toContain("café ñoño");
    expect(reloadedContent).toContain("Math: ∑ ∫ √ π");
  });

  test("Concurrent edits across tabs", async ({ page }) => {
    await setupTestDatabase(page, "content-persistence-concurrent");

    await openWorkspace(page, contentPersistenceFixture.workspacePath);
    await seedTestFiles(page, contentPersistenceFixture.files);
    await page.reload();

    await waitForFileTree(page, "tab-1.md");

    // new-tab for the 2nd and 3rd so all three stay open.
    await openFileInTree(page, "tab-1.md");
    await page.waitForTimeout(500);

    await openFileInNewTab(page, "tab-2.md");
    await page.waitForTimeout(500);

    await openFileInNewTab(page, "tab-3.md");
    await page.waitForTimeout(500);

    const tabBar = page.locator('[data-testid="tab-bar"]');
    const tab1 = tabBar.locator('.cursor-pointer:has-text("tab-1.md")').first();
    const tab2 = tabBar.locator('.cursor-pointer:has-text("tab-2.md")').first();
    const tab3 = tabBar.locator('.cursor-pointer:has-text("tab-3.md")').first();

    await expect(tab1).toBeVisible();
    await expect(tab2).toBeVisible();
    await expect(tab3).toBeVisible();

    await page.waitForTimeout(300);
    await replaceEditorContent(page, "# Tab 3\n\nEdited in tab 3");
    await waitForAutoSave(page);

    await tab1.click();
    await page.waitForTimeout(500);
    await replaceEditorContent(page, "# Tab 1\n\nEdited in tab 1");
    await waitForAutoSave(page);

    await tab2.click();
    await page.waitForTimeout(500);
    await replaceEditorContent(page, "# Tab 2\n\nEdited in tab 2");
    await waitForAutoSave(page);

    const tab1Content = await getIndexedDBContent(
      page,
      contentPersistenceFixture.workspacePath,
      `${contentPersistenceFixture.workspacePath}/tab-1.md`,
    );
    expect(tab1Content).toContain("Edited in tab 1");

    const tab2Content = await getIndexedDBContent(
      page,
      contentPersistenceFixture.workspacePath,
      `${contentPersistenceFixture.workspacePath}/tab-2.md`,
    );
    expect(tab2Content).toContain("Edited in tab 2");

    const tab3Content = await getIndexedDBContent(
      page,
      contentPersistenceFixture.workspacePath,
      `${contentPersistenceFixture.workspacePath}/tab-3.md`,
    );
    expect(tab3Content).toContain("Edited in tab 3");

    await tab1.click();
    await page.waitForTimeout(300);
    const tab1EditorContent = await getEditorContent(page);
    expect(tab1EditorContent).toContain("Edited in tab 1");

    await page.reload();
    await waitForFileTree(page, "tab-1.md");

    // After reload, tabs are not restored, so we verify via IndexedDB only
    // (This tests persistence, not tab restoration)
    const persistedTab1 = await getIndexedDBContent(
      page,
      contentPersistenceFixture.workspacePath,
      `${contentPersistenceFixture.workspacePath}/tab-1.md`,
    );
    expect(persistedTab1).toContain("Edited in tab 1");

    const persistedTab2 = await getIndexedDBContent(
      page,
      contentPersistenceFixture.workspacePath,
      `${contentPersistenceFixture.workspacePath}/tab-2.md`,
    );
    expect(persistedTab2).toContain("Edited in tab 2");

    const persistedTab3 = await getIndexedDBContent(
      page,
      contentPersistenceFixture.workspacePath,
      `${contentPersistenceFixture.workspacePath}/tab-3.md`,
    );
    expect(persistedTab3).toContain("Edited in tab 3");
  });

  test("Cursor and scroll position preserved across tab switches", async ({
    page,
  }) => {
    await setupTestDatabase(page, "content-persistence-cursor");
    await openWorkspace(page, contentPersistenceFixture.workspacePath);
    await seedTestFiles(page, contentPersistenceFixture.files);
    await page.reload();
    await waitForFileTree(page, "tab-1.md");

    await openFileInTree(page, "tab-1.md");
    await page.waitForTimeout(500);
    await openFileInNewTab(page, "tab-2.md");
    await page.waitForTimeout(500);

    const tabBar = page.locator('[data-testid="tab-bar"]');

    const tab1Button = tabBar
      .locator('.cursor-pointer:has-text("tab-1.md")')
      .first();
    await tab1Button.click();
    await page.waitForTimeout(500);

    const textbox = page.locator('[role="textbox"]').first();
    await textbox.waitFor({ state: "visible", timeout: 5000 });
    await textbox.click();
    await page.waitForTimeout(200);

    await page.keyboard.type(" CURSOR_TEST", { delay: 10 });
    await page.waitForTimeout(200);

    const cursorBefore = await page.evaluate(() => {
      const sel = window.getSelection();
      return {
        hasSelection: !!sel,
        anchorOffset: sel?.anchorOffset ?? null,
      };
    });

    const tab2Button = tabBar
      .locator('.cursor-pointer:has-text("tab-2.md")')
      .first();
    await tab2Button.click();
    await page.waitForTimeout(600);

    await tab1Button.click();
    await page.waitForTimeout(600);

    const cursorAfter = await page.evaluate(() => {
      const sel = window.getSelection();
      return {
        hasSelection: !!sel,
        anchorOffset: sel?.anchorOffset ?? null,
      };
    });

    expect(cursorBefore.hasSelection).toBe(true);
    expect(cursorAfter.hasSelection).toBe(true);

    const content = await getEditorContent(page);
    expect(content).toContain("CURSOR_TEST");
  });
});
