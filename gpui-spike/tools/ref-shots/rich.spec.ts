import { test } from "@playwright/test";
import { openDemo, shot, DEMO_FILES } from "./helpers";

// Every block type, for the editor typography comparison.
test("rich", async ({ page }) => {
  await page.goto("/");
  await openDemo(page, [...DEMO_FILES, { path: "/ref-ws/rich.md", type: "file" as const, content: "# Rich document\n\nA paragraph with **bold**, *italic*, `inline code` and a [link](https://example.com).\n\n## Second heading\n\nText under the second heading.\n\n### Third heading\n\n1. First\n2. Second\n\n- [ ] Open task\n- [x] Done task\n\n> A longer quote that says something.\n\n| Name | Value |\n| --- | --- |\n| a | 1 |\n| b | 2 |\n\n---\n\nLast paragraph.\n" }]);
  await page.getByRole("treeitem", { name: "rich.md" }).click();
  await shot(page, "rich-01-dark");
  await page.mouse.move(900, 600);
  await page.mouse.wheel(0, 400);
  await shot(page, "rich-02-dark-scrolled");
});
