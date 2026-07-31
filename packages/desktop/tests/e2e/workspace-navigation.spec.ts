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
    await setupTestDatabase(page, "workspace-navigation");
  });

  test("should open workspace and display file tree @smoke", async ({
    page,
  }) => {
    const fixture = workspaceNavigationFixture.populatedWorkspace;

    // Navigate first so the IndexedDB context is available before seeding.
    await openWorkspace(page, fixture.path);
    await seedTestFiles(page, fixture.files);
    await page.reload();
    await waitForFileTree(page);

    const readmeButton = page.getByRole("button", { name: "README.md" });
    await expect(readmeButton).toBeVisible();

    const notesButton = page.getByRole("button", { name: "notes.md" });
    await expect(notesButton).toBeVisible();

    const subfolderButton = page.getByRole("button", { name: "subfolder" });
    await expect(subfolderButton).toBeVisible();
  });

  test("should handle empty workspace @smoke", async ({ page }) => {
    const fixture = workspaceNavigationFixture.emptyWorkspace;

    await openWorkspace(page, fixture.path);
    await seedTestFiles(page, fixture.files);
    await page.reload();
    await waitForFileTree(page);

    const noFileMessage = page.getByText(
      "No file selected. Open a file from the sidebar or create a new one.",
    );
    await expect(noFileMessage).toBeVisible();

    const newFileButton = page.getByRole("button", { name: "New file" });
    await expect(newFileButton).toBeVisible();
  });

  test("should display workspace path in UI", async ({ page }) => {
    const fixture = workspaceNavigationFixture.populatedWorkspace;

    await openWorkspace(page, fixture.path);
    await seedTestFiles(page, fixture.files);
    await page.waitForLoadState("networkidle");

    const url = page.url();
    expect(url).toContain(encodeURIComponent(fixture.path));
  });
});
