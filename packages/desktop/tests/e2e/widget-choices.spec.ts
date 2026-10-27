/**
 * A prompt widget round that ends on a choice question (widget_respond's
 * single_choice / multiple_choice), end to end: the recording replays
 * through the mock harness, the widget lands in its "needs-answer" state,
 * and the user answers by pointer or by keyboard. Every answer is the next
 * prompt on the same session, so each test reads what went over the wire.
 *
 * The keyboard contract (deriveChoiceKey): ↑/↓ walk the options and then
 * the field as one line, so ↑ from an empty answer field lands on the last
 * option and ↓ past the last is the field again; ←/→ step round the
 * options, a digit or Space picks, Enter picks or sends a multiple
 * choice's picks, Escape goes back to the field, and any other key leaves
 * to type.
 *
 * Headed, each test stops at its interesting moments (Resume in the
 * inspector moves on); headless it runs straight through.
 */
import { test, expect, type Locator, type Page } from "@playwright/test";
import { setupTestDatabase } from "../setup/test-helpers";
import {
  collectionStats,
  lastWirePrompt,
  loadRecording,
  openDocument,
  promptTextOf,
  replayRecording,
  sendWidgetPrompt,
  summonWidget,
} from "../agent/agent-helpers";

// The widget is summoned onto "para one", below the heading.
const DOC = "# Plans\n\npara one\n\npara two\n";

/** A fresh document whose widget has asked the recording's question. */
async function asked(page: Page, name: string, fixture: string) {
  await setupTestDatabase(page, `widget-choices-${name}`);
  const editor = await openDocument(page, `/workspace/widget-choices-${name}`, "notes.md", DOC);
  const recording = loadRecording(fixture);
  await replayRecording(page, recording);
  const widget = await summonWidget(page, editor);
  await sendWidgetPrompt(page, widget, promptTextOf(recording, 0));
  await expect(face(widget)).toHaveAttribute("data-blob-phase", "needs-answer", {
    timeout: 30_000,
  });
  // The card grows to the question over a short height transition; until
  // it ends, the paragraph below still covers the answer field.
  await expect
    .poll(() =>
      draft(widget).evaluate((field) => {
        const box = field.getBoundingClientRect();
        const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        return Boolean(hit && field.contains(hit));
      }),
    )
    .toBe(true);
  return { editor, widget };
}

const face = (widget: Locator) => widget.locator("[data-blob-phase]");
const draft = (widget: Locator) => widget.locator("[data-prompt-draft]");
const option = (widget: Locator, name: string) =>
  widget.locator(`[data-choice-option="${name}"]`);
const focusedOption = (widget: Locator) => widget.locator("[data-choice-focused]");

/** The round ran and settled on the recording's answer. */
async function answered(page: Page, widget: Locator, sent: string) {
  await expect(face(widget)).toHaveAttribute("data-blob-response", "answer", {
    timeout: 30_000,
  });
  await expect(face(widget)).toHaveAttribute("data-blob-phase", "done");
  await expect(widget.locator("[data-choice]")).toHaveCount(0);
  const { prompt } = await lastWirePrompt(page);
  expect(prompt.find((block) => block.type === "text")?.text).toBe(sent);
  expect((await collectionStats(page)).turns).toBe(2);
}

/** Headed runs pause here for a look. */
async function stop(page: Page, headless: boolean) {
  if (!headless) await page.pause();
}

test.describe("prompt widget choices", () => {
  test.beforeEach(({ headless }) => {
    test.setTimeout(headless ? 90_000 : 0);
  });

  test("single choice: the question heads the card, and clicking an option answers it @smoke", async ({
    page,
    headless,
  }) => {
    const { widget } = await asked(page, "single-click", "widget-single-choice.json");
    await expect(face(widget)).toHaveAttribute("data-blob-response", "single_choice");
    await expect(widget).toContainText("Which tier should the section lead with?");
    await expect(widget).not.toContainText("Question");
    await expect(widget.locator("[data-choice-option]")).toHaveCount(2);
    await expect(draft(widget)).toHaveAttribute(
      "data-placeholder",
      // Dictation is on by default, so the hint names the hold key too.
      "↑ to pick, type, or hold right Ctrl to answer…",
    );
    await stop(page, headless);

    await option(widget, "Enterprise").click();
    await answered(page, widget, "Enterprise");
    await expect(widget).toContainText("Pricing section drafted");
    await stop(page, headless);
  });

  test("multiple choice: checkboxes collect picks; the send arrow appears with the first", async ({
    page,
    headless,
  }) => {
    const { widget } = await asked(page, "multi-click", "widget-multiple-choice.json");
    await expect(face(widget)).toHaveAttribute("data-blob-response", "multiple_choice");
    const send = widget.getByRole("button", { name: "Send" });
    await expect(send).toHaveCount(0);
    await stop(page, headless);

    await option(widget, "Pro").click();
    // The chip's label toggles it as well as the box.
    await widget.getByText("Enterprise", { exact: true }).click();
    await widget.getByText("Team", { exact: true }).click();
    await widget.getByText("Team", { exact: true }).click();
    await expect(widget.getByRole("checkbox", { checked: true })).toHaveCount(2);
    await expect(send).toBeVisible();
    await stop(page, headless);

    await send.click();
    await answered(page, widget, "- Pro\n- Enterprise");
  });

  test("keyboard, single choice: ↑ from the line below reaches the field, ↑ again the last option; arrows step and Enter picks", async ({
    page,
    headless,
  }) => {
    const { editor, widget } = await asked(page, "single-keys", "widget-single-choice.json");
    // The caret went back to the document on send: below the widget.
    await editor.locator("p", { hasText: "para one" }).click();
    await page.keyboard.press("Home");
    await page.keyboard.press("ArrowUp");
    await expect(focusedOption(widget)).toHaveCount(0);
    await page.keyboard.press("ArrowUp");
    await expect(focusedOption(widget)).toContainText("Enterprise");
    // While the keys are on the options, each shows the digit that picks it.
    await expect(widget.locator("kbd")).toHaveText(["1", "2"]);
    await stop(page, headless);

    // ↑/↓ step like ←/→; only ←/→ wrap round.
    await page.keyboard.press("ArrowUp");
    await expect(focusedOption(widget)).toContainText("Pro");
    await page.keyboard.press("ArrowDown");
    await expect(focusedOption(widget)).toContainText("Enterprise");
    await page.keyboard.press("ArrowRight");
    await expect(focusedOption(widget)).toContainText("Pro");
    await page.keyboard.press("ArrowLeft");
    await expect(focusedOption(widget)).toContainText("Enterprise");
    await page.keyboard.press("Enter");
    await answered(page, widget, "Enterprise");
  });

  test("keyboard: ↓ from above walks the options, then the field, then out below; ↑ walks back and out above", async ({
    page,
    headless,
  }) => {
    const { editor, widget } = await asked(page, "walk", "widget-single-choice.json");
    await editor.locator("h1").click();
    await page.keyboard.press("End");
    await page.keyboard.press("ArrowDown");
    await expect(focusedOption(widget)).toContainText("Pro");
    await stop(page, headless);
    await page.keyboard.press("ArrowDown");
    await expect(focusedOption(widget)).toContainText("Enterprise");
    await page.keyboard.press("ArrowDown");
    await expect(focusedOption(widget)).toHaveCount(0);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.type("!");
    await expect(editor.locator("p", { hasText: "!para one" })).toHaveCount(1);
    await page.keyboard.press("Backspace");

    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowUp");
    await expect(focusedOption(widget)).toContainText("Enterprise");
    await page.keyboard.press("ArrowUp");
    await expect(focusedOption(widget)).toContainText("Pro");
    await page.keyboard.press("ArrowUp");
    await expect(focusedOption(widget)).toHaveCount(0);
    await page.keyboard.type("?");
    await expect(editor.locator("h1")).toContainText("?");
    await expect(face(widget)).toHaveAttribute("data-blob-phase", "needs-answer");
  });

  test("keyboard, single choice: a digit answers directly", async ({ page }) => {
    const { widget } = await asked(page, "single-digit", "widget-single-choice.json");
    await draft(widget).click();
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("2");
    await answered(page, widget, "Enterprise");
  });

  test("keyboard, multiple choice: Space and digits toggle, Enter sends the picks @smoke", async ({
    page,
    headless,
  }) => {
    const { widget } = await asked(page, "multi-keys", "widget-multiple-choice.json");
    await draft(widget).click();
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowUp");
    await expect(focusedOption(widget)).toContainText("Pro");
    await page.keyboard.press("Space");
    await page.keyboard.press("3");
    await page.keyboard.press("2");
    await page.keyboard.press("2");
    await expect(widget.getByRole("checkbox", { checked: true })).toHaveCount(2);
    await expect(focusedOption(widget)).toContainText("Team");
    await stop(page, headless);

    await page.keyboard.press("Enter");
    await answered(page, widget, "- Pro\n- Enterprise");
  });

  test("↓ past the last option and Escape go back to the field; typing leaves the options and answers in words", async ({
    page,
  }) => {
    const { widget } = await asked(page, "free-text", "widget-single-choice.json");
    await draft(widget).click();
    await page.keyboard.press("ArrowUp");
    await expect(focusedOption(widget)).toHaveCount(1);
    await page.keyboard.press("ArrowDown");
    await expect(focusedOption(widget)).toHaveCount(0);
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("Escape");
    await expect(focusedOption(widget)).toHaveCount(0);
    // The widget is still asking: Escape left the options, not the widget.
    await expect(face(widget)).toHaveAttribute("data-blob-phase", "needs-answer");

    await page.keyboard.press("ArrowUp");
    await page.keyboard.type("Neither");
    await expect(focusedOption(widget)).toHaveCount(0);
    await expect(draft(widget)).toContainText("Neither");
    // With text in the field, ↑ is caret movement again, not the options.
    await page.keyboard.press("ArrowUp");
    await expect(focusedOption(widget)).toHaveCount(0);
    await draft(widget).click();
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await answered(page, widget, "Neither");
  });

  test("a click takes the keys off the options: a digit is then typed, never a pick", async ({
    page,
  }) => {
    const { widget } = await asked(page, "click-leaves", "widget-single-choice.json");
    await draft(widget).click();
    await page.keyboard.press("ArrowUp");
    await expect(focusedOption(widget)).toHaveCount(1);
    await draft(widget).click();
    await expect(focusedOption(widget)).toHaveCount(0);
    await page.keyboard.press("2");
    await expect(draft(widget)).toContainText("2");
    await expect(face(widget)).toHaveAttribute("data-blob-phase", "needs-answer");
    expect((await collectionStats(page)).turns).toBe(1);
  });

  test("multiple choice: Enter in the field sends the picks with the typed note", async ({
    page,
  }) => {
    const { widget } = await asked(page, "multi-note", "widget-multiple-choice.json");
    await option(widget, "Team").click();
    await draft(widget).click();
    await page.keyboard.type("monthly only");
    await page.keyboard.press("Enter");
    await answered(page, widget, "Team\n\nmonthly only");
  });

  test("a question widget can be dismissed without answering", async ({ page }) => {
    const { editor, widget } = await asked(page, "dismiss", "widget-single-choice.json");
    await widget.getByRole("button", { name: "Dismiss" }).click();
    await expect(page.locator('[data-type="ai-prompt"]').locator("visible=true")).toHaveCount(0);
    await expect(editor).toContainText("para one");
    expect((await collectionStats(page)).turns).toBe(1);
  });
});
