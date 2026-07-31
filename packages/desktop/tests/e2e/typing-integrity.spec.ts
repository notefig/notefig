import { test, expect } from "@playwright/test";
import {
  setupTestDatabase,
  openWorkspace,
  seedTestFiles,
  openFileInTree,
  getEditorContent,
  getIndexedDBContent,
  waitForFileTree,
} from "../setup/test-helpers";

/**
 * Regression test for typing integrity under continuous fast typing.
 *
 * The full pipeline runs: every editor update streams through DocumentSync
 * (worker serialize) → writeFileContent → content/metadata collections →
 * live query → adoption path. The invariant: no matter how fast the user
 * types, previously typed content is never reverted by the app's own save
 * echoes, and the persisted file converges to exactly what the editor
 * shows.
 *
 * Mirrors the reported setup: date-modified sort (metadata churn re-sorts
 * the tree on every save) and multiple modified files.
 */

const WORKSPACE = "/typing-integrity";

const FILES = [
  {
    path: `${WORKSPACE}/canto-i.md`,
    content: "# Canto I\n\nMidway upon the journey of our life.\n",
    type: "file" as const,
  },
  {
    path: `${WORKSPACE}/canto-ii.md`,
    content: "# Canto II\n\nDay was departing.\n",
    type: "file" as const,
  },
  {
    path: `${WORKSPACE}/target.md`,
    content: "# Target\n\nstart\n",
    type: "file" as const,
  },
];

test.describe("Typing integrity", () => {
  test("fast typing in bursts never loses or reverts content", async ({
    page,
  }) => {
    await setupTestDatabase(page, "typing-integrity");
    await openWorkspace(page, WORKSPACE);
    await seedTestFiles(page, FILES);

    // Match the reported environment: sort by date modified so every save's
    // metadata update re-sorts the tree.
    await page.goto(`/${encodeURIComponent(WORKSPACE)}?sort=date-modified`);
    await waitForFileTree(page, "target.md");

    await openFileInTree(page, "target.md");

    const editor = page.locator('[role="textbox"]').first();
    await editor.click();
    await page.keyboard.press("ControlOrMeta+End");

    // Six bursts of fast typing with pauses in between. Pauses are the idle
    // windows where a stale echo can be adopted; bursts create the save
    // backpressure. Each burst has a unique marker so any loss or
    // reordering is attributable.
    const bursts = ["alpha", "bravo", "carol", "delta", "echos", "final"];
    let typedSoFar = "";

    for (const marker of bursts) {
      const text = ` ${marker}-0123456789`;
      await editor.pressSequentially(text, { delay: 15 });
      typedSoFar += text;

      // Pause: let saves, collection emissions and re-sorts land while the
      // editor is idle.
      await page.waitForTimeout(700);

      // Nothing typed so far may have disappeared or been reverted.
      const current = await getEditorContent(page);
      for (const seen of bursts.slice(0, bursts.indexOf(marker) + 1)) {
        expect(
          current,
          `editor lost burst "${seen}" after typing "${marker}"`,
        ).toContain(`${seen}-0123456789`);
      }
    }

    // Let the pipeline fully drain.
    await page.waitForTimeout(1500);

    const finalEditor = await getEditorContent(page);
    for (const marker of bursts) {
      expect(finalEditor, `final editor lost burst "${marker}"`).toContain(
        `${marker}-0123456789`,
      );
    }
    // Exactly one occurrence each — a revert-then-retype duplicates text.
    for (const marker of bursts) {
      const occurrences = finalEditor.split(`${marker}-0123456789`).length - 1;
      expect(
        occurrences,
        `burst "${marker}" appears ${occurrences} times in the editor`,
      ).toBe(1);
    }

    // Disk must agree with the editor.
    const persisted = await getIndexedDBContent(
      page,
      WORKSPACE,
      `${WORKSPACE}/target.md`,
    );
    for (const marker of bursts) {
      expect(persisted, `persisted file lost burst "${marker}"`).toContain(
        `${marker}-0123456789`,
      );
    }
  });
});
