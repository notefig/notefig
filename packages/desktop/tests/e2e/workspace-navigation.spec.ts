import { test, expect } from "@playwright/test";
import {
  setupTestDatabase,
  seedTestFiles,
  waitForFileTree,
  openWorkspace,
  openWorkspaceInPlace,
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

    const readmeButton = page.getByRole("treeitem", { name: "README.md" });
    await expect(readmeButton).toBeVisible();

    const notesButton = page.getByRole("treeitem", { name: "notes.md" });
    await expect(notesButton).toBeVisible();

    const subfolderButton = page.getByRole("treeitem", { name: "subfolder" });
    await expect(subfolderButton).toBeVisible();

    // The project's config sits in the app dir, next to the scratchpads,
    // but isn't a note: the tree leaves it out.
    await expect(page.getByRole("treeitem", { name: /scratchpads/ })).toBeVisible();
    await expect(page.getByRole("treeitem", { name: "config.json" })).toHaveCount(0);
  });

  test("should handle empty workspace @smoke", async ({ page }) => {
    const fixture = workspaceNavigationFixture.emptyWorkspace;

    await openWorkspace(page, fixture.path);
    await seedTestFiles(page, fixture.files);
    await page.reload();
    await waitForFileTree(page);

    // An empty project lands in a fresh scratchpad (MET-135): the tree
    // shows the scratchpads folder and its one generated file, and an
    // editor is up rather than the empty state.
    await expect(
      page.getByRole("treeitem", { name: /scratchpads/ }),
    ).toBeVisible();
    await expect(
      page.locator('[role="textbox"]').locator("visible=true").first(),
    ).toBeVisible({ timeout: 15000 });

    const newFileButton = page.getByRole("button", { name: "New file" });
    await expect(newFileButton).toBeVisible();
  });

  test("bringing a tab forward focuses its workspace", async ({ page }) => {
    // Two empty projects, each landing in its own scratchpad tab.
    await openWorkspace(page, "/workspace/follows-tab-a");
    await openWorkspaceInPlace(page, "/workspace/follows-tab-b");
    const tabs = page.locator('div[title]:has(> div > button[aria-label="Close tab"])');
    await expect(tabs).toHaveCount(2);
    await page.getByRole("button", { name: "Everything", exact: true }).click();
    const project = (name: string) => page.getByRole("button", { name, exact: true });
    await expect(project("follows-tab-b")).toHaveAttribute("aria-current", "true");

    await tabs.first().click();
    await expect(project("follows-tab-a")).toHaveAttribute("aria-current", "true");
    await tabs.last().click();
    await expect(project("follows-tab-b")).toHaveAttribute("aria-current", "true");
  });
});
