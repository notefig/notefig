/**
 * Token usage end to end: the mock harness's echo scenario reports usage the
 * way real harnesses do (usage_update + per-turn PromptResponse.usage), and
 * the chat composer, the prompt footers and Settings → Usage show it.
 *
 *   npx playwright test --project=agent tests/agent/usage.spec.ts
 */
import { test, expect } from "@playwright/test";
import { setupTestDatabase } from "../setup/test-helpers";
import { sendAndSettle, startMockSession } from "./agent-helpers";

test("usage shows in the composer, under each prompt, and in settings", async ({
  page,
}) => {
  await setupTestDatabase(page, "usage");
  await startMockSession(page, "/workspace/usage");

  await sendAndSettle(page, "first prompt");
  await sendAndSettle(page, "second prompt");

  // Tokens in context against the window's limit, in the composer footer;
  // a click opens what the session has spent.
  const chip = page.getByTestId("session-usage");
  await expect(chip).toHaveText(/^[\d.]+k? \/ 200k$/);
  // It stays: a usage write that fails to persist is rolled back a beat
  // later, taking the session's totals with it.
  await page.waitForTimeout(1000);
  await chip.click();
  const details = page.getByTestId("session-usage-details");
  await expect(details).toContainText("Cost$");
  await expect(details).toContainText("Input");
  await expect(details).toContainText("/ 200k");
  await page.keyboard.press("Escape");
  await expect(details).toBeHidden();

  // What each turn spent, in tokens, in its prompt's (hover-revealed) footer.
  const turnUsage = page.locator('[data-entry-type="user"]').getByText(/tokens$/);
  await expect(turnUsage).toHaveCount(2);

  await page.goto(`${new URL(page.url()).pathname}?settings=usage`);
  const section = page.locator('[data-settings-section="usage"]');

  // Over time: every harness side by side (the mock runs under the default
  // harness, so it has all of it), with the limits each reported, and the
  // average day.
  await expect(section.getByTestId("usage-chart-harness")).toBeVisible();
  await expect(section.getByTestId("usage-chart-pattern")).toBeVisible();
  await expect(section.getByTestId("usage-chart-cache")).toBeVisible();
  const detail = section.getByTestId("usage-harness-detail");
  await expect(detail.getByTestId("usage-breakdown")).toContainText("100%");
  await expect(detail.getByTestId("usage-limits")).toContainText("five_hour");
  await expect(detail.getByTestId("usage-limits")).toContainText("42%");

  // One harness: its models over time, its limits.
  await section.getByTestId("usage-harness-select").click();
  await page.getByRole("menuitem", { name: "Claude" }).click();
  await expect(section.getByTestId("usage-chart-models")).toBeVisible();
  await expect(detail.getByTestId("usage-limits")).toContainText("five_hour");

  // Cost: a harness that never reports it is greyed in the picker.
  await section.getByRole("button", { name: "Cost", exact: true }).click();
  await section.getByTestId("usage-harness-select").click();
  await expect(page.getByRole("menuitem", { name: /Devin/ })).toHaveAttribute("data-greyed", "true");
  await page.keyboard.press("Escape");
});
