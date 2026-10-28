/**
 * An agent's diff block in the chat (```ts diff, see
 * @notefig/widgets/diff-block): the reply streams in, and the block is
 * drawn as a diff, with its file's name and its changed lines.
 *
 *   npx playwright test --project=agent tests/agent/diff-blocks.spec.ts
 */
import { test, expect } from "@playwright/test";
import { setupTestDatabase } from "../setup/test-helpers";
import {
  entries,
  loadRecording,
  promptTextOf,
  replayRecording,
  sendAndSettle,
  startMockSession,
} from "./agent-helpers";

test("a reply's diff block is drawn as a diff", async ({ page }) => {
  await setupTestDatabase(page, "chat-diff-blocks");
  await startMockSession(page, "/workspace/chat-diff-blocks");
  const recording = loadRecording("diff-reply.json");
  await replayRecording(page, recording);
  await sendAndSettle(page, promptTextOf(recording, 0));

  const reply = entries(page, "assistant").last();
  await expect(reply).toContainText("That's the only change.");
  await expect(reply.locator(".rendered > pre")).toHaveCount(0);
  const diff = reply.locator("notefig-diff-block diffs-container");
  await expect(diff).toHaveCount(1);
  await expect(diff.locator("[data-title]")).toHaveText("src/greet.ts");
  await expect(diff.locator('[data-line-type="change-deletion"]:not([data-column-number])').first()).toContainText("hi ${name}");
  await expect(diff.locator('[data-line-type="change-addition"]:not([data-column-number])').first()).toContainText("hello, ${name}");
});
