// Reference shots for the settings owner's surfaces: each settings section,
// search with results, the palette empty and with a query.
import { test } from "@playwright/test";
import { openDemo, shot } from "./helpers";

test("settings, search, palette", async ({ page }) => {
  await openDemo(page);
  await page.getByRole("treeitem", { name: "README.md" }).click();

  // Search with results.
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByPlaceholder("Search ref-ws").click();
  await page.keyboard.type("Notefig");
  await page.waitForTimeout(800);
  await shot(page, "settings-search-results");
  await page.getByPlaceholder("Search ref-ws").fill("i");
  await page.waitForTimeout(800);
  await shot(page, "settings-search-many");

  // Palette: empty, then a query that hits commands and files.
  await page.getByRole("button", { name: "Files", exact: true }).click();
  await page.getByRole("treeitem", { name: "README.md" }).click();
  await page.keyboard.press("Control+K");
  await shot(page, "settings-palette-empty");
  await page.keyboard.type("ne");
  await shot(page, "settings-palette-query");
  await page.keyboard.press("Control+A");
  await page.keyboard.type("getting");
  await shot(page, "settings-palette-file");
  await page.keyboard.press("Escape");

  // Each settings section, through the rail.
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.waitForTimeout(400);
  for (const name of ["General", "Appearance", "Hotkeys", "Harnesses", "Usage", "Privacy"]) {
    await page.getByRole("dialog").getByRole("button", { name, exact: true }).click();
    await page.waitForTimeout(700);
    await shot(page, `settings-section-${name.toLowerCase()}`);
  }
  await page.getByRole("dialog").getByRole("button", { name: "General", exact: true }).click();
  await page.waitForTimeout(700);
  await page.mouse.wheel(0, 300);
  await shot(page, "settings-section-general-advanced");
});
