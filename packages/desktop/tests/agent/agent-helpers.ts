/**
 * Helpers for agent-chat e2e specs: drive a mock-harness session
 * (VITE_AGENT_MOCK=1, see src/agent/mock-harness.ts) through the real UI.
 */
import type { Page } from "@playwright/test";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Open the workspace's sessions sidebar and start a mock-harness session. */
export async function startMockSession(
  page: Page,
  workspacePath: string,
): Promise<void> {
  const encoded = encodeURIComponent(workspacePath);
  await page.goto(`/${encoded}?sidebarView=sessions`);
  await page
    .getByRole("button", { name: /New session with/ })
    .first()
    .click();
  await page.getByRole("button", { name: "Trust & start" }).click();
  await composer(page).waitFor({ timeout: 15000 });
}

/** The prompt composer's editable surface (a Tiptap editor since MET-80). */
export function composer(page: Page) {
  return page.locator('.prompt-editor [role="textbox"]');
}

export async function configureScenario(
  page: Page,
  scenario: string,
  options: Record<string, unknown>,
): Promise<void> {
  await page.evaluate(
    ({ scenario, options }) =>
      (window as any).__mockAgent.configure({ scenario, options }),
    { scenario, options },
  );
}

export async function sendPrompt(page: Page, text: string): Promise<void> {
  await composer(page).fill(text);
  await composer(page).press("Enter");
}

/** The "Working…" shimmer is the turn-running signal. Filtered by text so
 *  other live regions (sonner's toaster) can't collide with the locator. */
function workingIndicator(page: Page) {
  return page.getByRole("status").filter({ hasText: "Working" });
}

export async function waitForRunning(page: Page): Promise<void> {
  await workingIndicator(page).waitFor({ state: "visible", timeout: 15000 });
}

export async function waitForIdle(
  page: Page,
  timeoutMs = 120_000,
): Promise<void> {
  await workingIndicator(page).waitFor({ state: "hidden", timeout: timeoutMs });
}

export async function collectionStats(
  page: Page,
): Promise<{ tasks: number; turns: number; entries: number }> {
  return page.evaluate(() => (window as any).__mockAgent.stats());
}
