import { test, expect } from "@playwright/test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  waitForFileTree,
  openWorkspace,
  openFileInTree,
  getEditorContent,
  replaceEditorContent,
} from "../setup/test-helpers";

/**
 * Real-backend shim smoke (MET-73). Proves the substrate the mock layers can't:
 * real UI → real `src/entities` → real Tauri adapter → real Rust `fs_ops` → real
 * files on disk. The temp workspace is a real directory this test creates with
 * Node's `fs`; the app never touches IndexedDB here (the shim transport routes
 * `invoke` to the running `test-shim` binary).
 *
 * Two directions are asserted:
 *   - READ:  a file seeded on disk shows up in the app's file tree.
 *   - WRITE: an edit made in the app is written back to the real file on disk.
 */
test.describe("shim: real filesystem round-trip", () => {
  let workspace = "";

  test.beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "metrists-shim-"));
    await fs.writeFile(
      path.join(workspace, "README.md"),
      "# Seeded on disk\n",
      "utf8",
    );
  });

  test.afterEach(async () => {
    if (workspace) await fs.rm(workspace, { recursive: true, force: true });
  });

  test("reads a seeded file and writes edits back to disk", async ({ page }) => {
    test.setTimeout(60000);

    // READ: open the real temp dir; the tree is populated by read_directory →
    // shim → real fs, not IndexedDB.
    await openWorkspace(page, workspace);
    await waitForFileTree(page, "README.md");
    await expect(
      page.getByRole("button", { name: "README.md" }),
    ).toBeVisible();

    // Open it and confirm the on-disk content came through read_files → shim.
    await openFileInTree(page, "README.md");
    await expect
      .poll(() => getEditorContent(page))
      .toContain("Seeded on disk");

    // WRITE: edit in the app; autosave persists through write_files → shim →
    // the real file. Assert on the actual filesystem, the ground truth.
    await replaceEditorContent(page, "# Edited in the app");

    await expect
      .poll(
        async () =>
          fs.readFile(path.join(workspace, "README.md"), "utf8"),
        { timeout: 15000 },
      )
      .toContain("Edited in the app");
  });
});
