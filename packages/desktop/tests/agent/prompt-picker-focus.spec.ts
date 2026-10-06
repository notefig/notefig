/**
 * The prompt widget's harness/session picker is a detour from typing, not a
 * destination: once a choice is made, the caret goes back to the widget's
 * composer, so the user can keep writing the prompt they were writing.
 *
 *   npx playwright test --project=agent tests/agent/prompt-picker-focus.spec.ts
 */
import { test, expect, type Locator, type Page } from "@playwright/test";
import { setupTestDatabase } from "../setup/test-helpers";
import { openDocument, sendWidgetPrompt, summonWidget } from "./agent-helpers";

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

function draftOf(widget: Locator) {
  return widget.locator("[data-prompt-draft]").first();
}

async function openPicker(page: Page, widget: Locator) {
  await widget.getByRole("button", { name: "Choose harness" }).click();
  await expect(page.getByRole("menu")).toBeVisible();
}

test.describe("prompt widget picker", () => {
  test.setTimeout(90_000);

  test("choosing a harness returns the caret to the composer", async ({
    page,
  }) => {
    const workspacePath = "/workspace/prompt-picker-harness";
    await setupTestDatabase(page, "prompt-picker-harness");
    const editor = await openDocument(page, workspacePath, "notes.md", "para one\n");
    const widget = await summonWidget(page, editor);
    await page.keyboard.type("half a prompt");

    await openPicker(page, widget);
    await page
      .getByRole("menuitem", { name: /^New .+ conversation$/ })
      .first()
      .click();
    await expect(page.getByRole("menu")).toBeHidden();

    await expect.poll(() => caretInDraftOf(widget)).toBe(true);
    await page.keyboard.type(", continued");
    await expect(draftOf(widget)).toHaveText("half a prompt, continued");
  });

  test("choosing a recent session returns the caret to the composer", async ({
    page,
  }) => {
    const workspacePath = "/workspace/prompt-picker-session";
    await setupTestDatabase(page, "prompt-picker-session");
    const editor = await openDocument(
      page,
      workspacePath,
      "notes.md",
      "para one\n\npara two\n",
    );
    // A first widget's round leaves a live session for the picker to list.
    const first = await summonWidget(page, editor);
    await sendWidgetPrompt(page, first, "start a session");
    await expect(draftOf(first)).toBeHidden();
    await expect(draftOf(first)).toBeVisible({ timeout: 30_000 });

    // A second widget, below the first, re-targets to that session.
    await editor.getByText("para two").click();
    await page.waitForTimeout(300);
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
    await page.keyboard.type("/");
    const widget = page
      .locator('[data-type="ai-prompt"]')
      .locator("visible=true")
      .nth(1);
    await expect(widget).toBeVisible();
    await page.keyboard.type("next step");

    await openPicker(page, widget);
    await page
      .getByRole("menuitem")
      .filter({ hasNotText: /^New .+ conversation$/ })
      .first()
      .click();
    await expect(page.getByRole("menu")).toBeHidden();

    await expect.poll(() => caretInDraftOf(widget)).toBe(true);
    await page.keyboard.type(" please");
    await expect(draftOf(widget)).toHaveText("next step please");
  });
});
