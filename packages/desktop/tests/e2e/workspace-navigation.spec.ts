import { test, expect } from "@playwright/test";
import {
  setupTestDatabase,
  seedTestFiles,
  waitForFileTree,
  openWorkspace,
} from "../setup/test-helpers";
import { workspaceNavigationFixture } from "./workspace-navigation.fixture";

test.describe("Workspace Navigation", () => {
  test.beforeEach(async ({ page }) => {
    // Set up isolated database for this test
    await setupTestDatabase(page, "workspace-navigation");
  });

  test("should open workspace and display file tree @smoke", async ({
    page,
  }) => {
    const fixture = workspaceNavigationFixture.populatedWorkspace;

    // Navigate to workspace first (so IndexedDB context is available)
    await openWorkspace(page, fixture.path);

    // Now seed the database with sample files
    await seedTestFiles(page, fixture.files);

    // Reload page to pick up the seeded data
    await page.reload();

    // Wait for file tree to render
    await waitForFileTree(page);

    // Check for README.md in the file tree (as a button)
    const readmeButton = page.getByRole("button", { name: "README.md" });
    await expect(readmeButton).toBeVisible();

    // Check for notes.md in the file tree
    const notesButton = page.getByRole("button", { name: "notes.md" });
    await expect(notesButton).toBeVisible();

    // Check for subfolder in the file tree
    const subfolderButton = page.getByRole("button", { name: "subfolder" });
    await expect(subfolderButton).toBeVisible();
  });

  test("should handle empty workspace @smoke", async ({ page }) => {
    const fixture = workspaceNavigationFixture.emptyWorkspace;

    // Navigate to workspace first
    await openWorkspace(page, fixture.path);

    // Seed with empty workspace (no files)
    await seedTestFiles(page, fixture.files);

    // Reload to pick up the seeded data
    await page.reload();

    // Wait for workspace to load
    await waitForFileTree(page);

    // Should show the "No file selected" message
    const noFileMessage = page.getByText(
      "No file selected. Open a file from the sidebar or create a new one.",
    );
    await expect(noFileMessage).toBeVisible();

    // New file button should be visible
    const newFileButton = page.getByRole("button", { name: "New file" });
    await expect(newFileButton).toBeVisible();
  });

  test("should display workspace path in UI", async ({ page }) => {
    const fixture = workspaceNavigationFixture.populatedWorkspace;

    // Navigate to workspace first
    await openWorkspace(page, fixture.path);

    // Seed the database with sample files
    await seedTestFiles(page, fixture.files);

    // Wait for page to load
    await page.waitForLoadState("networkidle");

    // Check that URL contains encoded workspace path
    const url = page.url();
    expect(url).toContain(encodeURIComponent(fixture.path));
  });
});
