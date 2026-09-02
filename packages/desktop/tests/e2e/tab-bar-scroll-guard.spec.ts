/**
 * Regression: the tab bar used to end up clipped under the top edge of its
 * window — top border and rounded corners gone, tabs sliced in half — with no
 * way to get it back. An `overflow: hidden` box is still a scroll port, so a
 * caret/focus scroll while a window's content briefly overflowed left a
 * permanent scroll offset on it. The layout boxes now use `overflow: clip`,
 * which clips without being scrollable at all.
 */
import { test, expect, type Page } from "@playwright/test";
import {
  openFileInNewTab,
  openFileInTree,
  openWorkspace,
  seedTestFiles,
  setupTestDatabase,
  waitForFileTree,
} from "../setup/test-helpers";

const WORKSPACE_PATH = "/workspace/tab-bar-scroll-guard";

const fixtureFiles = [
  {
    path: `${WORKSPACE_PATH}/a.md`,
    content: "# heading\n\nalpha",
    type: "file" as const,
  },
  {
    path: `${WORKSPACE_PATH}/b.md`,
    content: "bravo",
    type: "file" as const,
  },
];

/** How far the tab bar's top sits above its window's top edge. */
async function clippedBy(page: Page) {
  return page.evaluate(() => {
    const bar = document.querySelector(
      '[data-testid="tab-bar"]',
    ) as HTMLElement;
    const win = bar.parentElement as HTMLElement;
    return win.getBoundingClientRect().top - bar.getBoundingClientRect().top;
  });
}

test("an overflowing window can never scroll its tab bar out of view", async ({
  page,
}) => {
  await setupTestDatabase(page, "tab-bar-scroll-guard");
  await openWorkspace(page, WORKSPACE_PATH);
  await seedTestFiles(page, fixtureFiles);
  await page.reload();
  await waitForFileTree(page, "a.md");
  await openFileInTree(page, "a.md");
  await openFileInNewTab(page, "b.md");

  await expect(page.locator('[data-testid="tab-bar"]').first()).toBeVisible();
  expect(await clippedBy(page)).toBeCloseTo(0, 0);

  // Overflow the window the way a transient layout does, then scroll it the
  // way a focus/caret scroll would. A clipped box refuses both.
  const scrollTop = await page.evaluate(() => {
    const bar = document.querySelector(
      '[data-testid="tab-bar"]',
    ) as HTMLElement;
    const win = bar.parentElement as HTMLElement;
    const content = bar.nextElementSibling as HTMLElement;
    content.style.minHeight = `${win.clientHeight + 40}px`;
    content.style.flexShrink = "0";
    win.scrollTop = 40;
    return win.scrollTop;
  });

  expect(scrollTop).toBe(0);
  expect(await clippedBy(page)).toBeCloseTo(0, 0);
});
