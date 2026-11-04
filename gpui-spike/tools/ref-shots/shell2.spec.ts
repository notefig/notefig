import { test } from "@playwright/test";
import { openDemo, shot, DEMO_FILES } from "./helpers";

// Shell states for the GPUI port: collapsed sidebar, Everything, a split,
// a code file, the rail's context menu.
test("shell2", async ({ page }) => {
  await page.goto("/");
  await openDemo(page, [
    ...DEMO_FILES,
    { path: "/ref-ws/notes/hello.rs", type: "file" as const, content: 'fn main() {\n    println!("hi");\n}\n' },
  ]);
  await page.getByRole("treeitem", { name: "README.md" }).click();
  await page.keyboard.press("Control+\\");
  await shot(page, "shell2-01-collapsed");
  await page.keyboard.press("Control+\\");
  await page.getByRole("button", { name: "Everything" }).click();
  await shot(page, "shell2-02-everything");
  await page.getByRole("button", { name: "ref-ws", exact: true }).click();
  await page.getByRole("treeitem", { name: "hello.rs" }).click();
  await shot(page, "shell2-03-code");
  await page.getByRole("treeitem", { name: "ideas.md" }).click({ modifiers: ["Control"] });
  const tab = page.locator('[data-tab-id$="ideas.md"]');
  const box = await page.locator('[data-dockable-window-id]').first().boundingBox();
  if (box) {
    await tab.hover();
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 40, box.y + box.height / 2, { steps: 15 });
    await page.mouse.move(box.x + box.width - 30, box.y + box.height / 2, { steps: 5 });
    await page.mouse.up();
  }
  await shot(page, "shell2-04-split");
  await page.getByRole("button", { name: "ref-ws", exact: true }).click({ button: "right" }).catch(() => {});
  await shot(page, "shell2-05-rail-menu");
});
