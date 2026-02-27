/**
 * Debug test: Verify scroll/cursor position preservation when switching tabs.
 * This is a temporary diagnostic test.
 */
import { test, expect } from "@playwright/test";
import {
  setupTestDatabase,
  seedTestFiles,
  openWorkspace,
  waitForFileTree,
  openFileInTree,
} from "../setup/test-helpers";

const WORKSPACE_PATH = "/workspace/scroll-test";

// Generate a long markdown file so we can scroll
function generateLongContent(title: string, lines: number): string {
  let content = `# ${title}\n\n`;
  for (let i = 1; i <= lines; i++) {
    content += `Line ${i}: Lorem ipsum dolor sit amet, consectetur adipiscing elit.\n\n`;
  }
  return content;
}

const testFiles = [
  {
    path: `${WORKSPACE_PATH}/file-a.md`,
    content: generateLongContent("File A", 100),
    type: "file" as const,
  },
  {
    path: `${WORKSPACE_PATH}/file-b.md`,
    content: generateLongContent("File B", 100),
    type: "file" as const,
  },
];

test.describe("Scroll Position Debug", () => {
  test.beforeEach(async ({ page }) => {
    await setupTestDatabase(page, "scroll-debug");
    await openWorkspace(page, WORKSPACE_PATH);
    await seedTestFiles(page, testFiles);
    await page.reload();
    await waitForFileTree(page, "file-a.md");
  });

  test("should preserve scroll position when switching tabs", async ({
    page,
  }) => {
    // Collect console logs
    const logs: string[] = [];
    page.on("console", (msg) => {
      if (msg.text().includes("[text-editor]")) {
        logs.push(msg.text());
      }
    });

    // Open file A
    await openFileInTree(page, "file-a.md");
    await page.waitForTimeout(500);

    // Scroll file A down significantly — first find the actual scroll container
    const scrollInfoA = await page.evaluate(() => {
      // Walk up from the editor textbox to find the scrollable ancestor
      const editor = document.querySelector('[role="textbox"]');
      if (!editor) return { error: "no editor found" };

      let el: HTMLElement | null = editor as HTMLElement;
      while (el) {
        const style = window.getComputedStyle(el);
        if (
          (style.overflowY === "auto" || style.overflowY === "scroll") &&
          el.scrollHeight > el.clientHeight
        ) {
          el.scrollTop = 800;
          return {
            scrollTop: el.scrollTop,
            scrollHeight: el.scrollHeight,
            clientHeight: el.clientHeight,
            tagName: el.tagName,
            className: el.className.substring(0, 120),
            id: el.id,
          };
        }
        el = el.parentElement;
      }
      return { error: "no scrollable container found" };
    });
    console.log("File A scroll info:", JSON.stringify(scrollInfoA));

    await page.waitForTimeout(300);

    // Open file B
    await openFileInTree(page, "file-b.md");
    await page.waitForTimeout(500);

    // Scroll file B to a different position
    const scrollInfoB = await page.evaluate(() => {
      const editor = document.querySelector('[role="textbox"]');
      if (!editor) return { error: "no editor found" };

      let el: HTMLElement | null = editor as HTMLElement;
      while (el) {
        const style = window.getComputedStyle(el);
        if (
          (style.overflowY === "auto" || style.overflowY === "scroll") &&
          el.scrollHeight > el.clientHeight
        ) {
          el.scrollTop = 400;
          return { scrollTop: el.scrollTop };
        }
        el = el.parentElement;
      }
      return { error: "no scrollable container found" };
    });
    console.log("File B scroll info:", JSON.stringify(scrollInfoB));

    await page.waitForTimeout(300);

    // Switch back to file A by clicking its tab
    const tabA = page
      .locator("div.cursor-pointer")
      .filter({ hasText: "file-a.md" })
      .first();
    await tabA.click();
    await page.waitForTimeout(1000);

    // Check scroll position of file A
    const scrollAfterSwitchA = await page.evaluate(() => {
      const containers = document.querySelectorAll(
        "[class*='overflow-y-auto']",
      );
      for (const container of containers) {
        if (container.scrollHeight > container.clientHeight) {
          return {
            scrollTop: container.scrollTop,
            scrollHeight: container.scrollHeight,
            clientHeight: container.clientHeight,
            tagName: container.tagName,
            className: container.className.substring(0, 100),
          };
        }
      }
      return null;
    });
    console.log(
      "File A scroll after switch:",
      JSON.stringify(scrollAfterSwitchA),
    );

    // Switch back to file B
    const tabB = page
      .locator("div.cursor-pointer")
      .filter({ hasText: "file-b.md" })
      .first();
    await tabB.click();
    await page.waitForTimeout(1000);

    // Check scroll position of file B
    const scrollAfterSwitchB = await page.evaluate(() => {
      const containers = document.querySelectorAll(
        "[class*='overflow-y-auto']",
      );
      for (const container of containers) {
        if (container.scrollHeight > container.clientHeight) {
          return {
            scrollTop: container.scrollTop,
            scrollHeight: container.scrollHeight,
            clientHeight: container.clientHeight,
          };
        }
      }
      return null;
    });
    console.log(
      "File B scroll after switch:",
      JSON.stringify(scrollAfterSwitchB),
    );

    // Print all collected logs
    console.log("\n=== Text Editor Logs ===");
    for (const log of logs) {
      console.log(log);
    }
    console.log("=== End Logs ===\n");

    // Assert scroll was preserved (with some tolerance)
    expect(scrollAfterSwitchA?.scrollTop).toBeGreaterThan(400);
    expect(scrollAfterSwitchB?.scrollTop).toBeGreaterThan(200);
  });
});
