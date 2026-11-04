import { test } from "@playwright/test";
import { openDemo, shot } from "./helpers";

// Platform extras: the tunnel's status pill and pair dialog (web build
// only — on the desktop the pill renders nothing), and the settings
// updater button.
test("extras", async ({ page }) => {
  await openDemo(page);
  await shot(page, "extras-01-shell-with-tunnel-pill");
  await page.getByRole("button", { name: "Connect a machine" }).first().click();
  await page.waitForTimeout(400);
  await shot(page, "extras-02-pair-dialog");
  await page.getByPlaceholder("Paste pairing code").fill("not-a-code");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);
  await shot(page, "extras-03-pair-dialog-error");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  await page.keyboard.press("Control+,");
  await page.waitForTimeout(800);
  await shot(page, "extras-04-settings-updater");
});
