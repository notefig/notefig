/**
 * The command-center substrate: two workspaces open at once, an agent
 * session running in each, both chat tabs side by side in one dock — and
 * all of it back after a reload, because the open set is persisted and the
 * layout rides the URL the app restores.
 */
import { test, expect, type Page } from "@playwright/test";
import {
  setupTestDatabase,
  openWorkspace,
  openWorkspaceInPlace,
} from "../setup/test-helpers";
import { collectionStats, startMockSession } from "./agent-helpers";

const WS_A = "/workspace/two-workspaces-a";
const WS_B = "/workspace/two-workspaces-b";

/** The composer of the tab in view (inactive dock tabs are not visible). */
function visibleComposer(page: Page) {
  return page.locator('.prompt-editor [role="textbox"]').locator("visible=true");
}

function workingIndicators(page: Page) {
  return page.getByRole("status").filter({ hasText: "Working" });
}

/** Start a session in the focused workspace via the sidebar's + button. */
async function startSessionInFocusedWorkspace(page: Page): Promise<void> {
  await page
    .getByRole("button", { name: /New session with/ })
    .first()
    .click();
  await page.getByRole("button", { name: "Trust & start" }).click();
}

/** The dock's tab strip entries: a titled tab holding its close button. */
function dockTabs(page: Page) {
  return page.locator('div[title]:has(> div > button[aria-label="Close tab"])');
}

test.describe("two workspaces in one dock", () => {
  // Two sessions, two turns and a full reload: well past the default.
  test.setTimeout(120_000);

  test("sessions run in both workspaces, tabs share the dock, reload restores everything", async ({
    page,
  }) => {
    await setupTestDatabase(page, "two-workspaces");
    await openWorkspace(page, WS_A);
    await startMockSession(page, WS_A);
    await expect(visibleComposer(page)).toBeVisible();

    // Open the second workspace into the same dock: no reload, A's chat
    // tab stays; the sidebar now shows B, so "+" starts a session in B.
    await openWorkspaceInPlace(page, WS_B);
    await startSessionInFocusedWorkspace(page);
    await expect(dockTabs(page)).toHaveCount(3); // A's chat, B's scratchpad, B's chat

    // A turn in B (the tab in view), then a turn in A — both running.
    await visibleComposer(page).fill("hello from b");
    await visibleComposer(page).press("Enter");
    await dockTabs(page).first().click();
    await visibleComposer(page).fill("hello from a");
    await visibleComposer(page).press("Enter");
    // The mock turns are quick, so overlap is not something to assert on;
    // what matters is that both ran, each in its own task and workspace.
    await expect(workingIndicators(page)).toHaveCount(0, { timeout: 120_000 });
    await expect
      .poll(() => collectionStats(page), { timeout: 30_000 })
      .toMatchObject({ tasks: 2, turns: 2 });
    await expect(page.getByText("hello from a").first()).toBeVisible();
    await dockTabs(page).last().click();
    await expect(page.getByText("hello from b").first()).toBeVisible();

    // Both workspaces are listed as projects in the Everything view,
    // whichever is focused; the focused one (B) is the current row.
    await page
      .getByRole("button", { name: "Everything — all workspaces", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "two-workspaces-a", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "two-workspaces-b", exact: true }),
    ).toHaveAttribute("aria-current", "true");

    // Reload: the persisted open set and the restored URL bring back both
    // workspaces and every tab.
    await page.reload();
    // The open set, the task rows and the layout all come back from
    // storage; give the boot its time.
    await expect(dockTabs(page)).toHaveCount(3, { timeout: 30_000 });
    await expect(page.getByText("hello from a").first()).toBeVisible({
      timeout: 30_000,
    });
  });
});
