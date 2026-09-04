import { test, expect } from "@playwright/test";
import {
  getFileContentFromDB,
  openWorkspace,
  seedTestFiles,
  setupTestDatabase,
  waitForAutoSave,
  waitForFileTree,
  listScratchpadFiles,
} from "../setup/test-helpers";

const WORKSPACE_PATH = "/workspace/prompt-draft";

/**
 * The prompt widget's draft is content of the document, not state beside it.
 *
 * Which cuts both ways, and this is the side that could quietly corrupt a
 * user's work: every keystroke in a composer is now a document transaction,
 * and the autosave pipeline writes whatever it serializes with no equality
 * check. Typing an unsent prompt must still never touch the file.
 *
 * (The other side — that the caret in a draft is an ordinary selection, so
 * the tab layout restores it for free — is asserted in
 * tab-state-persistence.spec.ts, beside the caret and scroll tests it is now
 * the same mechanism as.)
 */
/** A document with a mounted prompt widget. "New file" opens an empty
 *  scratchpad, and the empty-document keeper puts a widget in it with the
 *  caret already in its draft — the same node view, and the same cascade, as
 *  one summoned with "/" mid-prose. */
async function summonWidget(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "New file" }).click();
}

test.describe("prompt draft persistence", () => {
  test.beforeEach(async ({ page }) => {
    await setupTestDatabase(page, "prompt-draft");
    await openWorkspace(page, WORKSPACE_PATH);
    await seedTestFiles(page, [
      {
        path: `${WORKSPACE_PATH}/notes.md`,
        content: "Some prose to switch away to.\n",
        type: "file" as const,
      },
    ]);
    await page.reload();
    await waitForFileTree(page, "notes.md");
  });

  test("typing a prompt never writes the file", async ({ page }) => {
    await summonWidget(page);
    const widget = page
      .locator('[data-type="ai-prompt"]')
      .locator("visible=true")
      .first();
    await expect(widget).toBeVisible();

    // Wait for the caret to actually be in the draft (the keeper's rule)
    // before typing, so this types exactly where a user's first keystroke
    // would land rather than racing the claim.
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const node = window.getSelection()?.anchorNode ?? null;
          const element =
            node instanceof Element ? node : (node?.parentElement ?? null);
          return Boolean(element?.closest("[data-prompt-draft]"));
        }),
      )
      .toBe(true);

    // The scratchpad is created on disk before any of this (with a
    // generated name — discover it, don't hardcode); snapshot it once it
    // is actually there, or "unchanged" would compare two nulls.
    await expect
      .poll(
        async () => (await listScratchpadFiles(page, WORKSPACE_PATH)).length,
      )
      .toBeGreaterThan(0);
    const [{ path: scratchpad }] = await listScratchpadFiles(
      page,
      WORKSPACE_PATH,
    );
    const original = await getFileContentFromDB(page, scratchpad);

    await page.keyboard.type("a long unsent prompt that must stay off disk");
    await expect(widget.locator("[data-prompt-draft]").first()).toContainText(
      "must stay off disk",
    );

    // Well past the autosave debounce. The pipeline writes whatever it
    // serializes with no equality check, so "the file is unchanged" can only
    // mean the save was never scheduled.
    await waitForAutoSave(page, 1500);

    expect(await getFileContentFromDB(page, scratchpad)).toBe(original);
  });
});
