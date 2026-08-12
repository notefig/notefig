import { test, expect } from "@playwright/test";
import {
  setupTestDatabase,
  seedTestFiles,
  waitForFileTree,
  openWorkspace,
  openFileInTree,
  openFileInNewTab,
  getEditorContent,
  replaceEditorContent,
  getFileContentFromDB,
  expandDirectory,
} from "../setup/test-helpers";
import { happyPathFixture } from "./happy-path.fixture";

test.describe("Happy Path - Complete User Flow", () => {
  test.beforeEach(async ({ page }) => {
    await setupTestDatabase(page, "happy-path");
  });

  test("should complete full editing workflow with persistence", async ({
    page,
  }) => {
    test.setTimeout(60000);
    const fixture = happyPathFixture.demoWorkspace;

    await openWorkspace(page, fixture.path);

    await seedTestFiles(page, fixture.files);

    await page.reload();

    await waitForFileTree(page, "README.md");

    const readmeButton = page.getByRole("treeitem", { name: "README.md" });
    await expect(readmeButton).toBeVisible();

    const docsButton = page.getByRole("treeitem", { name: "docs" });
    await expect(docsButton).toBeVisible();

    await expandDirectory(page, "docs");

    const gettingStartedButton = page.getByRole("treeitem", {
      name: "getting-started.md",
    });
    await expect(gettingStartedButton).toBeVisible();

    await openFileInTree(page, "README.md");

    await page.waitForSelector('[role="textbox"]', { timeout: 5000 });

    const originalContent = await getEditorContent(page);
    expect(originalContent).toContain("Demo Workspace");
    expect(originalContent).toContain("Welcome to Notefig");

    await replaceEditorContent(
      page,
      `# Test Heading

This content was added during testing.

${fixture.files[0].content}`,
    );

    await page.waitForTimeout(2000);

    const savedContent = await getFileContentFromDB(
      page,
      `${fixture.path}/README.md`,
    );
    expect(savedContent).toContain("# Test Heading");
    expect(savedContent).toContain("This content was added during testing");

    await page.waitForTimeout(500);

    await page.reload();

    await waitForFileTree(page, "README.md");

    // Re-open the file — tabs don't persist across reload yet.
    await openFileInTree(page, "README.md");
    await page.waitForSelector('[role="textbox"]', { timeout: 5000 });

    const restoredContent = await getEditorContent(page);
    // textContent strips markdown, so the "#" isn't present in the rendered heading.
    expect(restoredContent).toContain("Test Heading");
    expect(restoredContent).toContain("This content was added during testing");
  });

  test("should handle multi-file workflow with tab management", async ({
    page,
  }) => {
    const fixture = happyPathFixture.demoWorkspace;

    await openWorkspace(page, fixture.path);

    await seedTestFiles(page, fixture.files);

    await page.reload();

    await waitForFileTree(page);

    await expandDirectory(page, "docs");
    await expandDirectory(page, "notes");

    // new-tab for the 2nd and 3rd so all three stay open.
    await openFileInTree(page, "README.md");
    await page.waitForTimeout(500);

    await openFileInNewTab(page, "getting-started.md");
    await page.waitForTimeout(500);

    await openFileInNewTab(page, "2026-02-01.md");
    await page.waitForTimeout(500);

    const url = page.url();
    expect(url).toContain("README.md");
    expect(url).toContain("getting-started.md");
    expect(url).toContain("2026-02-01.md");

    const tabBar = page.locator('[data-testid="tab-bar"]');
    await tabBar.locator('.cursor-pointer:has-text("README.md")').first().click();
    await page.waitForTimeout(300);
    await replaceEditorContent(page, "# README Edit\n\nFirst file edited.");
    await page.waitForTimeout(1500);

    await tabBar.locator('.cursor-pointer:has-text("getting-started.md")').first().click();
    await page.waitForTimeout(300);
    await replaceEditorContent(
      page,
      "# Getting Started Edit\n\nSecond file edited.",
    );
    await page.waitForTimeout(1500);

    await tabBar.locator('.cursor-pointer:has-text("2026-02-01.md")').first().click();
    await page.waitForTimeout(300);
    await replaceEditorContent(page, "# Note Edit\n\nThird file edited.");
    await page.waitForTimeout(1500);

    const readmeContent = await getFileContentFromDB(
      page,
      `${fixture.path}/README.md`,
    );
    expect(readmeContent).toContain("README Edit");
    expect(readmeContent).toContain("First file edited");

    const gettingStartedContent = await getFileContentFromDB(
      page,
      `${fixture.path}/docs/getting-started.md`,
    );
    expect(gettingStartedContent).toContain("Getting Started Edit");
    expect(gettingStartedContent).toContain("Second file edited");

    const noteContent = await getFileContentFromDB(
      page,
      `${fixture.path}/notes/2026-02-01.md`,
    );
    expect(noteContent).toContain("Note Edit");
    expect(noteContent).toContain("Third file edited");

    await page.waitForTimeout(500);
    await page.reload();

    await waitForFileTree(page, "README.md");
    await page.waitForTimeout(1000);

    // Check IndexedDB directly rather than the UI: multi-file navigation
    // after reload is unreliable and covered by a separate test.
    const persistedReadme = await getFileContentFromDB(
      page,
      `${fixture.path}/README.md`,
    );
    expect(persistedReadme).toContain("README Edit");
    expect(persistedReadme).toContain("First file edited");

    const persistedGettingStarted = await getFileContentFromDB(
      page,
      `${fixture.path}/docs/getting-started.md`,
    );
    expect(persistedGettingStarted).toContain("Getting Started Edit");
    expect(persistedGettingStarted).toContain("Second file edited");

    const persistedNote = await getFileContentFromDB(
      page,
      `${fixture.path}/notes/2026-02-01.md`,
    );
    expect(persistedNote).toContain("Note Edit");
    expect(persistedNote).toContain("Third file edited");
  });
});
