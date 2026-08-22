/**
 * An agent tab is a tab like any other (MET-152): the general tab controls
 * reach its own surface. Collapsing the sidebar hands focus back to the
 * active tab — for a chat tab that means its composer, the way it means the
 * document for an editor tab (before MET-152 focus simply went nowhere).
 */
import { test, expect, type Page } from "@playwright/test";
import { setupTestDatabase, openWorkspace } from "../setup/test-helpers";
import { composer, startMockSession } from "./agent-helpers";

const WORKSPACE_PATH = "/workspace/agent-tab-controls";

/** Whether keyboard focus currently sits inside the agent composer. */
function focusInComposer(page: Page) {
  return page.evaluate(() =>
    Boolean(document.activeElement?.closest(".prompt-editor")),
  );
}

test.describe("agent tab controls", () => {
  test("focus returns to the composer when the sidebar collapses", async ({
    page,
  }) => {
    await setupTestDatabase(page, "agent-tab-controls");
    await openWorkspace(page, WORKSPACE_PATH);
    await startMockSession(page, WORKSPACE_PATH);
    await expect(composer(page)).toBeVisible();

    // Take focus out of the tab: the sessions list in the sidebar.
    await page
      .getByRole("button", { name: /New session with/ })
      .first()
      .focus();
    await expect.poll(() => focusInComposer(page)).toBe(false);

    await page.getByRole("button", { name: "Collapse sidebar" }).click();

    await expect.poll(() => focusInComposer(page)).toBe(true);
  });
});
