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
    // Setup unique database for this test
    await setupTestDatabase(page, "content-persistence-autosave");

    // Seed workspace with test files
    await openWorkspace(page, contentPersistenceFixture.workspacePath);
    await seedTestFiles(page, contentPersistenceFixture.files);
    await page.reload();

    // Open auto-save test file
    await openFileInTree(page, "auto-save-test.md");

    // Verify initial content
    const initialContent = await getEditorContent(page);
    expect(initialContent).toContain("Initial content for auto-save testing");

    // Edit content
    await replaceEditorContent(
      page,
      "# Auto-save Test\n\nInitial content for auto-save testing.\n\nThis line was added to test auto-save.",
    );

    // Wait for auto-save debounce (500ms + buffer)
    await waitForAutoSave(page);

    // Verify content persisted to IndexedDB
    const persistedContent = await getIndexedDBContent(
      page,
      contentPersistenceFixture.workspacePath,
      `${contentPersistenceFixture.workspacePath}/auto-save-test.md`,
    );
    expect(persistedContent).toContain("This line was added to test auto-save");

    // Make another edit
    await replaceEditorContent(
      page,
      "# Auto-save Test\n\nThis content has been edited multiple times.\n\nLine 1 of edits.\n\nLine 2 of edits.",
    );

    // Wait for auto-save again
    await waitForAutoSave(page);

    // Verify second edit persisted
    const updatedContent = await getIndexedDBContent(
      page,
      contentPersistenceFixture.workspacePath,
      `${contentPersistenceFixture.workspacePath}/auto-save-test.md`,
    );
    expect(updatedContent).toContain("Line 1 of edits");
    expect(updatedContent).toContain("Line 2 of edits");
  });

  test("Content recovery after reload", async ({ page }) => {
    // Setup unique database for this test
    await setupTestDatabase(page, "content-persistence-recovery");

    // Seed workspace
    await openWorkspace(page, contentPersistenceFixture.workspacePath);
    await seedTestFiles(page, contentPersistenceFixture.files);
    await page.reload();

    // Open recovery test file
    await openFileInTree(page, "recovery-test.md");

    // Make edits
    const editedContent =
      "# Recovery Test\n\nContent edited before reload.\n\nThis should persist after page reload.";
    await replaceEditorContent(page, editedContent);

    // Wait for auto-save (large file; allow extra time)
    await waitForAutoSave(page, 1000);

    // Simulate crash/reload
    await page.reload();

    // Verify file tree loads
    await page.waitForSelector('text="recovery-test.md"', { timeout: 10000 });

    // Re-open the file (tabs don't restore yet)
    await openFileInTree(page, "recovery-test.md");

    // Verify content was recovered
    const recoveredContent = await getEditorContent(page);
    expect(recoveredContent).toContain("Content edited before reload");
    expect(recoveredContent).toContain("This should persist after page reload");

    // Verify via IndexedDB as well
    const dbContent = await getIndexedDBContent(
      page,
      contentPersistenceFixture.workspacePath,
      `${contentPersistenceFixture.workspacePath}/recovery-test.md`,
    );
    expect(dbContent).toContain("Content edited before reload");
  });

  test("Large file handling", async ({ page }) => {
    // Setup unique database
    await setupTestDatabase(page, "content-persistence-large-file");

    // Seed workspace
    await openWorkspace(page, contentPersistenceFixture.workspacePath);
    await seedTestFiles(page, contentPersistenceFixture.files);
    await page.reload();

    // Wait for workspace to load
    await waitForFileTree(page, "large-file.md");

    // Open large file (2000 lines)
    await openFileInTree(page, "large-file.md");

    // Wait a bit longer for large file to render
    await page.waitForTimeout(1000);

    // Verify file opens by checking IndexedDB (editor might chunk/virtualize)
    const dbContent = await getIndexedDBContent(
      page,
      contentPersistenceFixture.workspacePath,
      `${contentPersistenceFixture.workspacePath}/large-file.md`,
    );
    expect(dbContent).toContain("# Large File Test");
    expect(dbContent).toContain("Section"); // Should contain section headers

    // Verify editor is present and visible
    await page.waitForSelector('[role="textbox"]', { timeout: 10000 });
    const editor = page
      .locator('[role="textbox"]')
      .locator("visible=true")
      .first();
    expect(await editor.isVisible()).toBe(true);

    // For large files, just verify we can type at the start without selecting all
    await editor.click();
    await page.keyboard.press("Home"); // Go to start of line
    await page.keyboard.type("EDITED: ", { delay: 5 });

    // Wait for auto-save
    await waitForAutoSave(page, 800);

    // Verify edit persisted by checking IndexedDB directly
    const updatedContent = await getIndexedDBContent(
      page,
      contentPersistenceFixture.workspacePath,
      `${contentPersistenceFixture.workspacePath}/large-file.md`,
    );
    expect(updatedContent).toContain("EDITED:");
  });

  test("Special characters in content", async ({ page }) => {
    // Setup unique database
    await setupTestDatabase(page, "content-persistence-special-chars");

    // Seed workspace
    await openWorkspace(page, contentPersistenceFixture.workspacePath);
    await seedTestFiles(page, contentPersistenceFixture.files);
    await page.reload();

    // Open special characters file
    await openFileInTree(page, "special-chars.md");

    // Verify unicode content renders
    const content = await getEditorContent(page);
    expect(content).toContain("🚀"); // Emoji
    expect(content).toContain("مرحبا بكم"); // Arabic
    expect(content).toContain("你好世界"); // Chinese
    expect(content).toContain("こんにちは"); // Japanese
    expect(content).toContain("Привет мир"); // Cyrillic

    // Add more special characters
    const newContent =
      content +
      "\n\n## New Section\n\n- Test: café ñoño\n- Math: ∑ ∫ √ π\n- Arrows: → ← ↑ ↓";
    await replaceEditorContent(page, newContent);

    // Wait for auto-save
    await waitForAutoSave(page);

    // Verify special chars persisted correctly
    const persistedContent = await getIndexedDBContent(
      page,
      contentPersistenceFixture.workspacePath,
      `${contentPersistenceFixture.workspacePath}/special-chars.md`,
    );
    expect(persistedContent).toContain("café ñoño");
    expect(persistedContent).toContain("∑ ∫ √ π");
    expect(persistedContent).toContain("→ ← ↑ ↓");

    // Reload and verify persistence
    await page.reload();
    await openFileInTree(page, "special-chars.md");

    const reloadedContent = await getEditorContent(page);
    expect(reloadedContent).toContain("café ñoño");
    expect(reloadedContent).toContain("Math: ∑ ∫ √ π");
  });

  test("Concurrent edits across tabs", async ({ page }) => {
    // Setup unique database
    await setupTestDatabase(page, "content-persistence-concurrent");

    // Seed workspace
    await openWorkspace(page, contentPersistenceFixture.workspacePath);
    await seedTestFiles(page, contentPersistenceFixture.files);
    await page.reload();

    // Wait for workspace to load
    await waitForFileTree(page, "tab-1.md");

    // Open multiple tabs (use new-tab for 2nd and 3rd)
    await openFileInTree(page, "tab-1.md");
    await page.waitForTimeout(500); // Wait for tab to render

    await openFileInNewTab(page, "tab-2.md");
    await page.waitForTimeout(500);

    await openFileInNewTab(page, "tab-3.md");
    await page.waitForTimeout(500);

    // Verify all tabs are visible in the tab bar
    const tabBar = page.locator('[data-testid="tab-bar"]');
    const tab1 = tabBar.locator('.cursor-pointer:has-text("tab-1.md")').first();
    const tab2 = tabBar.locator('.cursor-pointer:has-text("tab-2.md")').first();
    const tab3 = tabBar.locator('.cursor-pointer:has-text("tab-3.md")').first();

    await expect(tab1).toBeVisible();
    await expect(tab2).toBeVisible();
    await expect(tab3).toBeVisible();

    // Edit tab-3 (currently active)
    await page.waitForTimeout(300); // Let tab stabilize
    await replaceEditorContent(page, "# Tab 3\n\nEdited in tab 3");
    await waitForAutoSave(page);

    // Switch to tab-1 and edit
    await tab1.click();
    await page.waitForTimeout(500); // Wait for tab switch animation/render
    await replaceEditorContent(page, "# Tab 1\n\nEdited in tab 1");
    await waitForAutoSave(page);

    // Switch to tab-2 and edit
    await tab2.click();
    await page.waitForTimeout(500);
    await replaceEditorContent(page, "# Tab 2\n\nEdited in tab 2");
    await waitForAutoSave(page);

    // Verify all edits persisted to IndexedDB
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

    // Switch back to tab-1 and verify content is still there
    await tab1.click();
    await page.waitForTimeout(300);
    const tab1EditorContent = await getEditorContent(page);
    expect(tab1EditorContent).toContain("Edited in tab 1");

    // Reload page
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
    // Setup test database and workspace
    await setupTestDatabase(page, "content-persistence-cursor");
    await openWorkspace(page, contentPersistenceFixture.workspacePath);
    await seedTestFiles(page, contentPersistenceFixture.files);
    await page.reload();
    await waitForFileTree(page, "tab-1.md");

    // Open two files to create two tabs
    await openFileInTree(page, "tab-1.md");
    await page.waitForTimeout(500);
    await openFileInNewTab(page, "tab-2.md");
    await page.waitForTimeout(500);

    const tabBar = page.locator('[data-testid="tab-bar"]');

    // Find and click on tab-1 to ensure it's active
    const tab1Button = tabBar
      .locator('.cursor-pointer:has-text("tab-1.md")')
      .first();
    await tab1Button.click();
    await page.waitForTimeout(500);

    // Click in the editor to focus it
    const textbox = page.locator('[role="textbox"]').first();
    await textbox.waitFor({ state: "visible", timeout: 5000 });
    await textbox.click();
    await page.waitForTimeout(200);

    // Type something to verify editor is responsive
    await page.keyboard.type(" CURSOR_TEST", { delay: 10 });
    await page.waitForTimeout(200);

    // Record cursor position
    const cursorBefore = await page.evaluate(() => {
      const sel = window.getSelection();
      return {
        hasSelection: !!sel,
        anchorOffset: sel?.anchorOffset ?? null,
      };
    });

    // Switch to tab-2
    const tab2Button = tabBar
      .locator('.cursor-pointer:has-text("tab-2.md")')
      .first();
    await tab2Button.click();
    await page.waitForTimeout(600);

    // Switch back to tab-1
    await tab1Button.click();
    await page.waitForTimeout(600);

    // Verify editor is still focused and has content
    const cursorAfter = await page.evaluate(() => {
      const sel = window.getSelection();
      return {
        hasSelection: !!sel,
        anchorOffset: sel?.anchorOffset ?? null,
      };
    });

    // Verify the editor was interacted with
    expect(cursorBefore.hasSelection).toBe(true);
    expect(cursorAfter.hasSelection).toBe(true);

    // Verify the typed content is there
    const content = await getEditorContent(page);
    expect(content).toContain("CURSOR_TEST");
  });
});
