/**
 * MET-284: a prompt widget shows which session it belongs to, quietly. The
 * agent names the session once (`session_rename`); every widget of the
 * session carries the same tag (its mark: a shape in the session's color),
 * whose tooltip is that name; and the tag counts the prompts the session
 * was sent after the widget's own ("1 newer"), without moving the heading, and
 * still after a reload.
 */
import { test, expect, type Locator, type Page } from "@playwright/test";
import { openFileInTree, setupTestDatabase, waitForFileTree } from "../setup/test-helpers";
import {
  loadRecording,
  openDocument,
  promptTextOf,
  replayRecording,
  sendWidgetPrompt,
  summonWidget,
} from "../agent/agent-helpers";

const WS = "/workspace/widget-session";
const DOC = "# Pitch\n\npara one\n\npara two\n";

const face = (widget: Locator) => widget.locator("[data-blob-phase]");
const mark = (widget: Locator) => widget.locator("[data-session-mark]");

/** The app's tooltip over a widget's session mark. */
async function markTooltip(page: Page, widget: Locator): Promise<Locator> {
  await mark(widget).hover();
  return page.getByRole("tooltip");
}
/** The session's tag: its mark, and "N newer" for the prompts sent after this one. */
const tag = (widget: Locator) => widget.locator("[data-session-tag]");

/** A widget by the answer it settled on. */
const settled = (page: Page, answer: string) =>
  page.locator('[data-type="ai-prompt"]').locator("visible=true").filter({ hasText: answer });

test.describe("prompt widget session", () => {
  test.setTimeout(120_000);

  test("widgets of one session share its mark, and the older one counts the newer prompt", async ({
    page,
  }) => {
    await setupTestDatabase(page, "widget-session");
    const editor = await openDocument(page, WS, "notes.md", DOC);
    const recording = loadRecording("widget-session.json");
    await replayRecording(page, recording);

    await sendWidgetPrompt(page, await summonWidget(page, editor), promptTextOf(recording, 0));
    const first = settled(page, "Shortened the opening");
    await expect(face(first)).toHaveAttribute("data-blob-phase", "done", { timeout: 30_000 });
    // One heading: the response's title. The session's name, which the
    // agent gave it, is only the mark's tooltip.
    await expect(first).toContainText("Shortened the opening");
    await expect(first).not.toContainText("Pitch rewrite");
    // The session's mark is picked at random: a color and a shape, both set.
    await expect(mark(first)).toHaveAttribute("data-session-mark", /^\d+:\d+$/);
    const sessionMark = (await mark(first).getAttribute("data-session-mark"))!;
    await expect(await markTooltip(page, first)).toContainText("Pitch rewrite");
    await page.mouse.move(0, 0);
    await expect(tag(first)).toHaveText("");
    const heading = first.getByText("Shortened the opening");
    const before = await heading.boundingBox();

    // A second widget joins the same session (the workspace's last).
    // It lands under the first widget, so nothing above the first moves.
    await sendWidgetPrompt(page, await summonWidget(page, editor), promptTextOf(recording, 1));
    const second = settled(page, "Tightened the close");
    await expect(face(second)).toHaveAttribute("data-blob-phase", "done", { timeout: 30_000 });
    await expect(mark(second)).toHaveAttribute("data-session-mark", sessionMark);

    await expect(tag(first)).toHaveText("1 newer");
    await expect(tag(second)).toHaveText("");
    // The count came in on the tag: the heading didn't move.
    const after = await heading.boundingBox();
    expect({ x: after?.x, y: after?.y }).toEqual({ x: before?.x, y: before?.y });

    // Let the autosave write the widgets' markers, then come back.
    await page.waitForTimeout(2500);
    await page.reload();
    await waitForFileTree(page, "notes.md");
    await openFileInTree(page, "notes.md");
    await editor.waitFor();
    const restored = settled(page, "Shortened the opening");
    await expect(face(restored)).toHaveAttribute("data-blob-phase", "done", { timeout: 15_000 });
    await expect(tag(restored)).toHaveText("1 newer");
    await expect(mark(restored)).toHaveAttribute("data-session-mark", sessionMark);
    await expect(await markTooltip(page, restored)).toContainText("Pitch rewrite");
    await page.mouse.move(0, 0);

    // A fresh widget's picker shows the harness logo while no session waits
    // (none does after a reload), the mark of a session picked for it, and
    // the logo again once a new conversation lets go of that session.
    const fresh = page.locator('[data-type="ai-prompt"]').filter({ has: page.locator("[data-session-picker]") });
    await summonWidget(page, editor);
    const picker = fresh.locator("[data-session-picker]");
    await expect(picker).toHaveAttribute("data-session-picker", "");
    await picker.click();
    await page.locator("[data-session-option]").first().click();
    await expect(picker.locator("[data-session-mark]")).toHaveAttribute("data-session-mark", sessionMark);
    await expect(page.getByRole("menu")).toHaveCount(0);
    await picker.click();
    await expect(page.getByRole("menu")).toBeVisible();
    await page.getByRole("menuitem", { name: /New .* conversation/ }).first().click();
    await expect(picker).toHaveAttribute("data-session-picker", "");
    await expect(picker.locator("[data-session-mark]")).toHaveCount(0);
  });
});
