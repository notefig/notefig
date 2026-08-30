import { test, expect } from "@playwright/test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  waitForFileTree,
  openWorkspace,
  openFileInTree,
} from "../setup/test-helpers";

const SCRIPT_TS = [
  "export function greetFromTypescript(name: string): string {",
  "  return `Hello, ${name}!`;",
  "}",
  "",
  "export const answer = 42;",
  "",
].join("\n");

/**
 * MET-147 — code files open in the read-only @pierre/diffs viewer instead
 * of the markdown editor. The stakes: routing a .ts file through the
 * markdown codec rewrites it on autosave (the round-trip corruption bug),
 * so this suite asserts both the new surface AND that the file's bytes are
 * untouched after opening and typing at it.
 */
test.describe("shim: read-only code viewer", () => {
  let workspace = "";

  test.beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "metrists-shim-"));
    await fs.writeFile(path.join(workspace, "script.ts"), SCRIPT_TS);
    await fs.writeFile(path.join(workspace, "notes.md"), "# Notes\n");
  });

  test.afterEach(async () => {
    if (workspace) await fs.rm(workspace, { recursive: true, force: true });
  });

  test("a .ts file opens read-only with its content rendered, and its bytes survive", async ({
    page,
  }) => {
    test.setTimeout(60000);

    await openWorkspace(page, workspace);
    await waitForFileTree(page, "script.ts");
    // waitForEditor:false — the code viewer has no [role="textbox"].
    await openFileInTree(page, "script.ts", { waitForEditor: false });

    // The viewer container mounts keyed by the file path, and the file's
    // code is rendered inside it (Playwright text queries pierce the
    // CodeView's shadow root).
    const container = page.locator(
      `[data-editor-container="${path.join(workspace, "script.ts")}"]`,
    );
    await expect(container).toBeVisible();
    await expect(page.getByText("greetFromTypescript").first()).toBeVisible({
      timeout: 10000,
    });

    // Read-only: no editable surface mounts for a code file.
    await expect(page.locator('[role="textbox"]:visible')).toHaveCount(0);

    // Typing at the viewer must be inert — no editor, no autosave.
    await container.click();
    await page.keyboard.type("this text must go nowhere");
    // Sit out the autosave debounce window the markdown editor would use.
    await page.waitForTimeout(1500);

    const onDisk = await fs.readFile(path.join(workspace, "script.ts"), "utf8");
    expect(onDisk).toBe(SCRIPT_TS);
  });

  test("markdown files still open in the editable editor", async ({ page }) => {
    test.setTimeout(60000);

    await openWorkspace(page, workspace);
    await waitForFileTree(page, "notes.md");
    await openFileInTree(page, "notes.md");

    await expect(
      page.locator('[role="textbox"]:visible').first(),
    ).toBeVisible();
  });

  /**
   * Boot-restore regression: with the tab already in the layout URL, the
   * viewer mounts while content is still loading. Two bugs conspired to
   * leave it permanently empty: useOpenFileRows' select constant-folded
   * `isContentLoaded` to a hardcoded true (TanStack DB select callbacks
   * run once with ref proxies, so plain JS operators don't survive), and
   * CodeView drops controlled item updates whose `version` doesn't move.
   */
  test("boot-restoring a code tab from the layout URL renders content", async ({
    page,
  }) => {
    test.setTimeout(60000);

    const filePath = path.join(workspace, "script.ts");
    const layout = JSON.stringify([
      {
        type: "Window",
        id: "editor-window",
        children: [filePath],
        selected: filePath,
        size: 1,
      },
    ]);
    await page.goto(
      `/${encodeURIComponent(workspace)}?layout=${encodeURIComponent(layout)}`,
    );

    await expect(page.getByText("greetFromTypescript").first()).toBeVisible({
      timeout: 15000,
    });
  });
});
