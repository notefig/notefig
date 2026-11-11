/**
 * MET-284: a prompt widget shows which session it belongs to, quietly. The
 * agent names the session once (`session_rename`); every widget of the
 * session carries the same colored dot, whose tooltip is that name; and a
 * widget's footer says how many prompts the session was sent after its
 * own — appearing under the card's content without moving it, and still
 * there after a reload.
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
const dot = (widget: Locator) => widget.locator("[data-session-dot]");
const footer = (widget: Locator) => widget.locator("[data-session-footer]");

/** A widget by the answer it settled on. */
const settled = (page: Page, answer: string) =>
  page.locator('[data-type="ai-prompt"]').locator("visible=true").filter({ hasText: answer });

test.describe("prompt widget session", () => {
  test.setTimeout(120_000);

  test("widgets of one session share its dot, and the older one counts the newer prompt", async ({
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
    // agent gave it, is only the dot's tooltip.
    await expect(first).toContainText("Shortened the opening");
    await expect(first).not.toContainText("Pitch rewrite");
    await expect(dot(first)).toHaveAttribute("title", "Pitch rewrite");
    await expect(dot(first)).toHaveAttribute("data-session-dot", "0");
    await expect(footer(first)).toHaveCount(0);
    const heading = first.getByText("Shortened the opening");
    const before = await heading.boundingBox();

    // A second widget joins the same session (the workspace's last).
    // It lands under the first widget, so nothing above the first moves.
    await sendWidgetPrompt(page, await summonWidget(page, editor), promptTextOf(recording, 1));
    const second = settled(page, "Tightened the close");
    await expect(face(second)).toHaveAttribute("data-blob-phase", "done", { timeout: 30_000 });
    await expect(dot(second)).toHaveAttribute("data-session-dot", "0");
    await expect(dot(second)).toHaveAttribute("title", "Pitch rewrite");

    await expect(footer(first)).toHaveText("1 newer");
    await expect(footer(second)).toHaveCount(0);
    // The footer came in under the content: the heading didn't move.
    expect(await heading.boundingBox()).toEqual(before);

    // Let the autosave write the widgets' markers, then come back.
    await page.waitForTimeout(2500);
    await page.reload();
    await waitForFileTree(page, "notes.md");
    await openFileInTree(page, "notes.md");
    await editor.waitFor();
    const restored = settled(page, "Shortened the opening");
    await expect(face(restored)).toHaveAttribute("data-blob-phase", "done", { timeout: 15_000 });
    await expect(footer(restored)).toHaveText("1 newer");
    await expect(dot(restored)).toHaveAttribute("title", "Pitch rewrite");
  });
});
