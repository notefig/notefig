/**
 * The virtualized transcript's guardrails (MET-149): the mounted DOM stays
 * bounded while the collections hold every entry, and follow mode pins /
 * detaches / re-pins correctly around a streaming turn. Fails against the
 * old render-everything transcript — with 2000+ mounted entries the app
 * dropped to ~2fps while streaming (the long-history slog).
 */
import { test, expect } from "@playwright/test";
import { setupTestDatabase, openWorkspace } from "../setup/test-helpers";
import {
  collectionStats,
  configureScenario,
  sendPrompt,
  startMockSession,
  waitForIdle,
  waitForRunning,
} from "./agent-helpers";

const WORKSPACE_PATH = "/workspace/agent-virtualization";

/** The transcript's scroll surface (virtualized container, or the
 *  message-scroller primitive's viewport pre-MET-149). */
const VIEWPORT =
  '[data-transcript-viewport], [data-slot="message-scroller-viewport"]';
/** One mounted transcript row, in either rendering. */
const ROW = '[data-index], [data-slot="message-scroller-item"]';

/** Distance from the transcript scroll surface's live edge, in px. */
async function distanceFromEnd(page: import("@playwright/test").Page) {
  return page.evaluate((selector) => {
    const el = document.querySelector(selector) as HTMLElement;
    return el.scrollHeight - el.scrollTop - el.clientHeight;
  }, VIEWPORT);
}

test.describe("virtualized transcript", () => {
  test.beforeEach(async ({ page }) => {
    await setupTestDatabase(page, "agent-virtualization");
  });

  test("bounded DOM, full collection, follow-mode pin/detach/re-pin", async ({
    page,
  }) => {
    test.setTimeout(300_000);
    await openWorkspace(page, WORKSPACE_PATH);
    await startMockSession(page, WORKSPACE_PATH);

    // Seed a long history through the real streaming pipeline.
    await configureScenario(page, "longTranscript", {
      sections: 150,
      delayMs: 0,
      chunkSize: 400,
    });
    await sendPrompt(page, "seed history");
    await waitForRunning(page);
    await waitForIdle(page);

    // The virtualization invariant: collections hold everything, the DOM
    // holds a viewport's worth.
    const { entries } = await collectionStats(page);
    expect(entries).toBeGreaterThan(300);
    // The floor only proves rows are actually mounted (guards the ROW
    // selector against rot); the ceiling is the virtualization invariant.
    const domRows = await page.locator(ROW).count();
    expect(domRows).toBeGreaterThanOrEqual(5);
    expect(domRows).toBeLessThan(80);

    // A finished turn leaves the view at the live edge.
    expect(await distanceFromEnd(page)).toBeLessThanOrEqual(48);

    // Start a live turn and detach mid-stream — with real wheel input
    // (detachment is intent-based; programmatic scrolls don't count).
    await configureScenario(page, "longTranscript", {
      sections: 4,
      delayMs: 30,
      chunkSize: 60,
      seedLabel: "live",
    });
    await sendPrompt(page, "live turn");
    await waitForRunning(page);
    await page.waitForTimeout(300);
    await page.locator(VIEWPORT).hover();
    await page.mouse.wheel(0, -3000);
    await page.waitForTimeout(400);
    const scrollTop = () =>
      page.evaluate(
        (selector) =>
          (document.querySelector(selector) as HTMLElement).scrollTop,
        VIEWPORT,
      );
    const detachedTop = await scrollTop();
    await page.waitForTimeout(600);
    const laterTop = await scrollTop();
    // Streaming must not yank a detached reader back to the bottom.
    expect(Math.abs(laterTop - detachedTop)).toBeLessThanOrEqual(5);
    expect(await distanceFromEnd(page)).toBeGreaterThan(300);

    // The scroll-to-end button is active while detached; clicking re-pins.
    const button = page.getByRole("button", { name: "Scroll to end" });
    await expect(button).toHaveAttribute("data-active", "true");
    await button.click();
    await expect
      .poll(() => distanceFromEnd(page), { timeout: 5000 })
      .toBeLessThanOrEqual(48);

    // Re-armed: the rest of the stream keeps the view pinned.
    await waitForIdle(page);
    expect(await distanceFromEnd(page)).toBeLessThanOrEqual(48);
    await expect(button).toHaveAttribute("data-active", "false");
  });
});
