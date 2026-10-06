/**
 * "Seen" follows the tab the user navigates to, in whichever dock window
 * it lives. A session's chat tab split off into its own window must clear
 * its attention mark when the user goes to it there, the same as it does
 * in the first window.
 *
 *   npx playwright test --project=agent tests/agent/seen-split-window.spec.ts
 */
import { test, expect, type Locator, type Page } from "@playwright/test";
import {
  openFileInNewTab,
  openWorkspace,
  seedTestFiles,
  setupTestDatabase,
} from "../setup/test-helpers";
import {
  collectionStats,
  loadRecording,
  promptTextOf,
  replayRecording,
  sendAndSettle,
  sendPrompt,
  sessionRows,
  startMockSession,
} from "./agent-helpers";

const CHAT_TAB = '[data-testid="tab-bar"] [data-tab-id^="agent:"]';

function dockWindows(page: Page) {
  return page.locator("[data-dockable-window-id]");
}

/** Drag the chat tab onto the first window's right edge: its own window. */
async function splitChatTabRight(page: Page) {
  const windowBox = (await dockWindows(page).first().boundingBox())!;
  const tabBox = (await page.locator(CHAT_TAB).first().boundingBox())!;
  await page.mouse.move(tabBox.x + tabBox.width / 2, tabBox.y + tabBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(tabBox.x + tabBox.width / 2 + 15, tabBox.y + 15, {
    steps: 3,
  });
  await page.mouse.move(
    windowBox.x + windowBox.width - 8,
    windowBox.y + windowBox.height / 2,
    { steps: 12 },
  );
  await page.mouse.up();
  await expect(dockWindows(page)).toHaveCount(2);
}

type Navigate = (page: Page, chatWindow: Locator) => Promise<void>;

const NAVIGATIONS: Record<string, Navigate> = {
  "its tab header": async (_page, chatWindow) => {
    await chatWindow.locator("[data-tab-id^='agent:']").click();
  },
  "its sessions sidebar row": async (page) => {
    await sessionRows(page).first().click();
  },
};

test.describe("seen in a split window", () => {
  test.setTimeout(120_000);

  for (const [via, navigate] of Object.entries(NAVIGATIONS)) {
    test(`going to a split-off chat tab via ${via} clears its attention mark`, async ({
      page,
    }) => {
      const workspacePath = "/workspace/seen-split-window";
      await setupTestDatabase(page, "seen-split-window");
      await openWorkspace(page, workspacePath);
      await seedTestFiles(page, [
        { path: `${workspacePath}/notes.md`, content: "# notes\n", type: "file" },
      ]);
      await startMockSession(page, workspacePath);
      // Paced so the turn is still running when the user looks away.
      const recording = loadRecording("streaming-slow.json");
      await replayRecording(page, recording, { speed: 0.1, maxDelayMs: 3_000 });
      await sendAndSettle(page, promptTextOf(recording, 0));

      // The chat tab next to a document, then split into its own window.
      await page.getByRole("button", { name: "Files", exact: true }).click();
      await openFileInNewTab(page, "notes.md");
      await splitChatTabRight(page);
      const [firstWindow, chatWindow] = await dockWindows(page).all();
      await expect(chatWindow.locator("[data-tab-id^='agent:']")).toHaveCount(1);

      // Send from the chat, then look away at the document while it runs.
      const before = (await collectionStats(page)).settledTurns;
      await sendPrompt(page, "again");
      await firstWindow.locator(".ProseMirror").first().click();
      await expect
        .poll(async () => (await collectionStats(page)).settledTurns, {
          timeout: 60_000,
        })
        .toBe(before + 1);

      await page.getByRole("button", { name: "Sessions", exact: true }).click();
      const glyph = () =>
        sessionRows(page).first().locator("[data-status-glyph]");
      await expect(glyph()).toHaveAttribute("data-status-glyph", "attention-bau");

      await navigate(page, chatWindow);
      await page.getByRole("button", { name: "Sessions", exact: true }).click();
      await expect(glyph()).toHaveAttribute("data-status-glyph", "idle");
    });
  }
});
