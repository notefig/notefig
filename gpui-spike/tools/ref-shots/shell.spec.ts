import { test } from "@playwright/test";
import { openDemo, shot } from "./helpers";

test("shell", async ({ page }) => {
  await page.goto("/");
  await page.waitForTimeout(1500);
  await shot(page, "shell-00-welcome");
  await openDemo(page);
  await page.getByRole("treeitem", { name: "README.md" }).click();
  await shot(page, "shell-01-workspace");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.keyboard.type("Notefig");
  await shot(page, "shell-02-search");
  await page.getByRole("button", { name: "Git", exact: true }).click();
  await shot(page, "shell-03-git");
  await page.getByRole("button", { name: "Sessions", exact: true }).click();
  await shot(page, "shell-04-sessions");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await shot(page, "shell-05-settings");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+Shift+P");
  await shot(page, "shell-06-palette");
});
