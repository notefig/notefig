import { test, expect } from "@playwright/test";
import {
  setupTestDatabase,
  openWorkspace,
  seedTestFiles,
  openFileInTree,
  getEditorContent,
  waitForAutoSave,
  getIndexedDBContent,
  getFileContentFromDB,
  waitForFileTree,
  simulateExternalFileDeletion,
} from "../setup/test-helpers";
import { contentLoadingFixture } from "./content-loading.fixture";

/**
 * Content loading lifecycle tests.
 *
 * The editor must never mount before file content has loaded: a Tiptap
 * instance created with empty content risks persisting an empty document
 * over the real file (empty-write) and silently discards keystrokes typed
 * during loading. These tests pin down the invariants:
 *  - opening a file never writes to it (small, large, empty)
 *  - a file whose content read fails shows an error state, never an editor
 *  - newly created files still get an editor (not stuck on the placeholder)
 */
test.describe("Content Loading", () => {
  const ws = contentLoadingFixture.workspacePath;

  test("Opening a small file never writes to it", async ({ page }) => {
    await setupTestDatabase(page, "content-loading-small");
    await openWorkspace(page, ws);
    await seedTestFiles(page, contentLoadingFixture.files);
    await page.reload();

    const original = contentLoadingFixture.files.find(
      (f) => f.path === `${ws}/small-file.md`,
    )!.content;

    await openFileInTree(page, "small-file.md");

    const content = await getEditorContent(page);
    expect(content).toContain("A short document that loads quickly");

    // Sit past the autosave debounce without touching the editor —
    // merely opening the file must not trigger any write.
    await waitForAutoSave(page);

    const persisted = await getIndexedDBContent(
      page,
      ws,
      `${ws}/small-file.md`,
    );
    expect(persisted).toBe(original);
  });

  test("Opening a large file never empty-writes during load", async ({
    page,
  }) => {
    await setupTestDatabase(page, "content-loading-large");
    await openWorkspace(page, ws);
    await seedTestFiles(page, contentLoadingFixture.files);
    await page.reload();

    const original = contentLoadingFixture.files.find(
      (f) => f.path === `${ws}/large-loading-file.md`,
    )!.content;

    await waitForFileTree(page, "large-loading-file.md");
    await openFileInTree(page, "large-loading-file.md");

    // While loading, the tab must show either the loading placeholder or
    // the fully loaded editor — never a visible empty editable document.
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const state = await page.evaluate(() => {
        const editors = Array.from(
          document.querySelectorAll('[role="textbox"]'),
        );
        const visible = editors.find(
          (el) => window.getComputedStyle(el).display !== "none",
        );
        return {
          hasVisibleEditor: !!visible,
          visibleEditorEmpty: visible
            ? (visible.textContent ?? "").trim() === ""
            : false,
        };
      });
      if (state.hasVisibleEditor) {
        expect(state.visibleEditorEmpty).toBe(false);
        break;
      }
      await page.waitForTimeout(50);
    }

    // Content fully loads, including the end of the document.
    await expect
      .poll(async () => getEditorContent(page), { timeout: 10000 })
      .toContain("LAST_LINE_MARKER");

    // Opening never wrote to the file.
    await waitForAutoSave(page);
    const persisted = await getIndexedDBContent(
      page,
      ws,
      `${ws}/large-loading-file.md`,
    );
    expect(persisted).toBe(original);
  });

  test("An empty file gets an editable editor, not a stuck placeholder", async ({
    page,
  }) => {
    await setupTestDatabase(page, "content-loading-empty");
    await openWorkspace(page, ws);
    await seedTestFiles(page, contentLoadingFixture.files);
    await page.reload();

    await openFileInTree(page, "empty-file.md");

    // Editor mounts even though content is legitimately empty.
    const editor = page
      .locator('[role="textbox"]')
      .locator("visible=true")
      .first();
    await editor.waitFor({ state: "visible", timeout: 10000 });

    await editor.click();
    await editor.pressSequentially("Typed into empty file", { delay: 10 });
    await waitForAutoSave(page);

    const persisted = await getIndexedDBContent(page, ws, `${ws}/empty-file.md`);
    expect(persisted).toContain("Typed into empty file");
  });

  test("Creating a new file opens an editable editor", async ({ page }) => {
    await setupTestDatabase(page, "content-loading-new-file");
    await openWorkspace(page, ws);
    await seedTestFiles(page, contentLoadingFixture.files);
    await page.reload();
    await waitForFileTree(page, "small-file.md");

    // "New File" is instant (MET-135): an untitled scratchpad opens with
    // no naming prompt; it must reach an editable editor rather than sit
    // on the loading placeholder.
    await page.getByRole("button", { name: "New file" }).click();
    const editor = page
      .locator('[role="textbox"]')
      .locator("visible=true")
      .first();
    await editor.waitFor({ state: "visible", timeout: 10000 });

    await editor.click();
    await editor.pressSequentially("Hello from a scratchpad", { delay: 10 });
    await waitForAutoSave(page);

    // The empty-entry auto-open may have claimed untitled.md first, so the
    // clicked-into file is whichever untitled file holds the typed text.
    await expect
      .poll(async () => {
        for (const name of ["untitled.md", "untitled-2.md"]) {
          const content = await getIndexedDBContent(
            page,
            ws,
            `${ws}/.metrists/scratchpads/${name}`,
          ).catch(() => null);
          if (content?.includes("Hello from a scratchpad")) return true;
        }
        return false;
      })
      .toBe(true);
  });

  test("A failed content read never mounts an editor", async ({
    page,
  }) => {
    await setupTestDatabase(page, "content-loading-read-failure");
    await openWorkspace(page, ws);
    await seedTestFiles(page, contentLoadingFixture.files);
    await page.reload();
    await waitForFileTree(page, "doomed-file.md");

    // Metadata has loaded (the file is in the tree). Now remove the file's
    // storage row so the on-demand content read fails.
    await simulateExternalFileDeletion(page, `${ws}/doomed-file.md`);

    await openFileInTree(page, "doomed-file.md", { waitForEditor: false });

    // A missing file contributes NO content row (fabricating one poisoned
    // recreated paths — MET-135), so the tab sits on the loading
    // placeholder until metadata catches up and prunes it. The guard that
    // matters: no editor may mount over the failed read.
    await expect(page.getByText("doomed-file.md")).toBeVisible({
      timeout: 10000,
    });

    // No editable document is shown for the failed file.
    const visibleEditors = await page.evaluate(() => {
      const editors = Array.from(document.querySelectorAll('[role="textbox"]'));
      return editors.filter(
        (el) => window.getComputedStyle(el).display !== "none",
      ).length;
    });
    expect(visibleEditors).toBe(0);

    // Nothing wrote the file back into storage (an empty-write would
    // recreate the row with empty content).
    await waitForAutoSave(page);
    const row = await getFileContentFromDB(page, `${ws}/doomed-file.md`);
    expect(row).toBeNull();
  });
});
