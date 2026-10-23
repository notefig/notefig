/**
 * MET-251: a prompt widget's settled face outlives the run. The round is
 * stored with its outcome when it settles, so after a reload the widget
 * restored from its file marker shows the same Done face — not a blank
 * composer — even though the turn's transcript didn't survive.
 */
import { test, expect, type Page } from "@playwright/test";
import {
  openFileInTree,
  openWorkspace,
  seedTestFiles,
  setupTestDatabase,
  waitForFileTree,
} from "../setup/test-helpers";

const WS = "/workspace/widget-outcome";
const ANSWER = "OUTCOME_SENTINEL: shortened the paragraph.";

function widgets(page: Page) {
  return page.locator('[data-type="ai-prompt"]').locator("visible=true");
}

test.describe("prompt widget outcome", () => {
  test.setTimeout(120000);

  test("a settled widget shows its answer again after a reload", async ({
    page,
  }) => {
    await setupTestDatabase(page, "widget-outcome");
    await openWorkspace(page, WS);
    await seedTestFiles(page, [
      {
        path: `${WS}/doc.md`,
        content: ["para one", "", "para two", ""].join("\n"),
        type: "file" as const,
      },
    ]);
    await page.reload();
    await waitForFileTree(page, "doc.md");
    await openFileInTree(page, "doc.md");
    const editor = page.locator(".ProseMirror").locator("visible=true").first();
    await editor.waitFor();

    await page.evaluate((answer) => {
      const mock = (window as any).__mockAgent;
      mock.register("answer", () => async (ctx: any) => {
        ctx.emit({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: answer },
        });
        return { stopReason: "end_turn" };
      });
      mock.configure({ scenario: "answer" });
    }, ANSWER);

    // Summon a widget on a new line above the first paragraph and send
    // through the trust gate (first Enter arms it, second confirms).
    await editor.locator("p").first().click({ position: { x: 1, y: 8 } });
    await page.keyboard.press("Enter");
    await page.keyboard.press("ArrowUp");
    await page.waitForTimeout(300);
    await page.keyboard.type("/");
    await expect(widgets(page)).toHaveCount(1, { timeout: 10000 });
    await page.keyboard.type("shorten this");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");

    const widget = widgets(page).first();
    await expect(widget.locator('[data-blob-phase="done"]')).toBeVisible({
      timeout: 30000,
    });
    await expect(widget).toContainText(ANSWER);
    // Let the autosave write the widget's marker into the file.
    await page.waitForTimeout(2500);

    await page.reload();
    await waitForFileTree(page, "doc.md");
    await openFileInTree(page, "doc.md");
    await expect(editor).toContainText("para one");
    const restored = widgets(page).first();
    await expect(restored.locator('[data-blob-phase="done"]')).toBeVisible({
      timeout: 15000,
    });
    await expect(restored).toContainText(ANSWER);
  });
});
