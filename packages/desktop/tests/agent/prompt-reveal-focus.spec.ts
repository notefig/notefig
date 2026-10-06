/**
 * Jumping to a prompt widget from the Everything sidebar lands the user in
 * its composer, ready to type: the jump goes through `core.tabs.reveal`,
 * which scrolls the widget into view AND puts the caret in its draft.
 *
 *   npx playwright test --project=agent tests/agent/prompt-reveal-focus.spec.ts
 */
import { test, expect, type Locator } from "@playwright/test";
import { setupTestDatabase } from "../setup/test-helpers";
import {
  openDocument,
  sendWidgetPrompt,
  summonWidget,
} from "./agent-helpers";

/** True while the document holds focus with its caret in this widget's
 *  draft (composer). */
function caretInDraftOf(widget: Locator) {
  return widget.evaluate((root) => {
    const node = window.getSelection()?.anchorNode ?? null;
    const element =
      node instanceof Element ? node : (node?.parentElement ?? null);
    const draft = element?.closest("[data-prompt-draft]");
    return (
      Boolean(draft && root.contains(draft)) &&
      document.activeElement === root.closest(".ProseMirror")
    );
  });
}

test.describe("revealing a prompt widget", () => {
  test.setTimeout(90_000);

  test("a prompt round in the Everything sidebar focuses the widget's composer", async ({
    page,
  }) => {
    const workspacePath = "/workspace/prompt-reveal-focus";
    await setupTestDatabase(page, "prompt-reveal-focus");
    const editor = await openDocument(
      page,
      workspacePath,
      "notes.md",
      "para one\n\npara two\n",
    );
    const widget = await summonWidget(page, editor);
    await sendWidgetPrompt(page, widget, "REVEAL_ROUND say hi");
    // The round settles: its reply row (the draft) is back on screen.
    await expect(widget.locator("[data-prompt-draft]").first()).toBeHidden();
    await expect(widget.locator("[data-prompt-draft]").first()).toBeVisible({
      timeout: 30_000,
    });

    // Move the caret out of the widget, into the prose.
    await editor.getByText("para two").click();
    await expect.poll(() => caretInDraftOf(widget)).toBe(false);

    await page.getByRole("button", { name: "Everything", exact: true }).click();
    const row = page.locator('button[title^="REVEAL_ROUND say hi"]').first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.click();

    await expect(widget).toBeInViewport();
    await expect.poll(() => caretInDraftOf(widget)).toBe(true);

    // Typing lands in the composer, not the prose around it.
    await page.keyboard.type("follow up");
    await expect(widget.locator("[data-prompt-draft]").first()).toHaveText(
      "follow up",
    );
  });
});
