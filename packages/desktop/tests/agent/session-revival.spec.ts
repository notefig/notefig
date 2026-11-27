/**
 * A saved session comes back by itself: after a reload its chat tab, once
 * shown, loads the session (session/load) — no button to press — and its
 * transcript is the harness's history, and a prompt continues it.
 *
 * Runs in the `agent` Playwright project (VITE_AGENT_MOCK=1).
 */
import { test, expect } from "@playwright/test";
import { setupTestDatabase } from "../setup/test-helpers";
import { entries, sendAndSettle, sessionRows, startMockSession } from "./agent-helpers";

/* eslint-disable @typescript-eslint/no-explicit-any */

test("a restored session loads its history when its tab is shown", async ({ page }) => {
  test.setTimeout(90_000);
  await setupTestDatabase(page, "session-revival");
  await startMockSession(page, "/workspace/session-revival");
  await sendAndSettle(page, "remember this");
  await expect(entries(page, "assistant").last()).toContainText("remember this");

  await page.reload();
  // Shown again, the tab revives its session on its own.
  await expect(entries(page, "assistant").last()).toContainText("remember this", {
    timeout: 30_000,
  });
  await expect(sessionRows(page).first()).toHaveAttribute("data-session-status", "idle", {
    timeout: 30_000,
  });
  await expect(page.getByRole("button", { name: "Load history" })).toHaveCount(0);

  await sendAndSettle(page, "and this");
  const sessions = await page.evaluate(() =>
    (window as any).__mockAgent.prompts().map((p: { sessionId: string }) => p.sessionId),
  );
  // The prompt went to the session the reload loaded.
  expect(sessions).toHaveLength(1);
  const stored = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("notefig:mock-session-histories") ?? "[]").map(
      ([id]: [string]) => id,
    ),
  );
  expect(stored).toContain(sessions[0]);
});
