/**
 * Prompt directives (MET-225): `@model:` and `@skill:` picked from the "@"
 * menu like a file, kept as chips, and acted on only when the prompt is
 * sent — the model switched before the turn, the skill placed where the
 * harness runs commands (Claude, the mock's default harness: the last
 * block), and neither left in the text.
 *
 *   npx playwright test --project=agent tests/agent/directives.spec.ts
 */
import { test, expect, type Page } from "@playwright/test";
import { setupTestDatabase } from "../setup/test-helpers";
import {
  collectionStats,
  composer,
  lastWirePrompt,
  lastWireSet,
  openDocument,
  sendWidgetPrompt,
  startMockSession,
  summonWidget,
} from "./agent-helpers";

/* eslint-disable @typescript-eslint/no-explicit-any */

const modelOption = {
  id: "model",
  name: "Model",
  category: "model",
  type: "select",
  currentValue: "opus",
  options: [
    { value: "opus", name: "Opus" },
    { value: "sonnet", name: "Sonnet" },
  ],
};

const commands = [{ name: "review", description: "Review the branch" }];

const menu = (page: Page) => page.getByRole("listbox");

/** Type an "@" query and pick the row with this text. */
async function pick(page: Page, query: string, row: string) {
  await page.keyboard.type(query);
  await menu(page).getByRole("option", { name: row }).first().click();
}

async function settled(page: Page, count: number) {
  await expect
    .poll(async () => (await collectionStats(page)).settledTurns, { timeout: 60_000 })
    .toBe(count);
}

test("in the chat, a model and a skill are picked as chips and acted on at send", async ({
  page,
}) => {
  await setupTestDatabase(page, "directives-chat");
  await startMockSession(
    page,
    "/workspace/directives-chat",
    { configOptions: [modelOption] },
    commands,
  );
  await composer(page).click();

  // A bare "@" offers the namespaces; picking one keeps typing into it.
  await page.keyboard.type("@");
  await menu(page).getByRole("option", { name: "model:" }).click();
  await menu(page).getByRole("option", { name: /Sonnet/ }).click();
  await expect(composer(page)).toContainText("@model: Sonnet");
  // Picking changes nothing yet.
  expect(await lastWireSet(page, "session/set_config_option")).toBeNull();

  await pick(page, "@skill:", "review");
  await page.keyboard.type("fix it");
  await page.keyboard.press("Enter");
  await settled(page, 1);

  expect(await lastWireSet(page, "session/set_config_option")).toMatchObject({
    configId: "model",
    value: "sonnet",
  });
  const { prompt: blocks } = await lastWirePrompt(page);
  expect(blocks[0]).toEqual({ type: "text", text: "fix it" });
  expect(blocks[blocks.length - 1]).toEqual({ type: "text", text: "/review" });
});

test("members are offered while typing, and a row moved to stays selected as the query grows", async ({
  page,
}) => {
  await setupTestDatabase(page, "directives-typing");
  await startMockSession(
    page,
    "/workspace/directives-typing",
    { configOptions: [modelOption] },
    commands,
  );
  await composer(page).click();
  const option = (name: string) => menu(page).getByRole("option", { name });

  // Starting a namespace's name lists its members, each with its icon.
  await page.keyboard.type("@mo");
  await expect(option("model: Opus")).toHaveAttribute("aria-selected", "true");
  await expect(option("model: Sonnet").locator("svg")).toHaveCount(1);
  await page.keyboard.press("ArrowDown");
  await expect(option("model: Sonnet")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.type("d");
  await expect(option("model: Opus")).toBeVisible();
  await expect(option("model: Sonnet")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(composer(page)).toContainText("@model: Sonnet");

  // A member's own name finds it too, top row first.
  await page.keyboard.type("@rev");
  await expect(option("skill: review Review the branch")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(composer(page)).toContainText("@skill: review");
});

test("a pointer resting on the menu doesn't take the selection as the rows change", async ({
  page,
}) => {
  await setupTestDatabase(page, "directives-pointer");
  const skills = Array.from({ length: 5 }, (_, i) => ({ name: `skill-${i}`, description: "" }));
  await startMockSession(page, "/workspace/directives-pointer", { configOptions: [] }, skills);
  await composer(page).click();
  await page.keyboard.type("@sk");
  const rows = menu(page).getByRole("option");
  const selected = () =>
    rows.evaluateAll((els) => els.findIndex((el) => el.getAttribute("aria-selected") === "true"));

  // A real move onto a row selects it.
  const box = (await rows.nth(2).boundingBox())!;
  const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(at.x, at.y - 2);
  await page.mouse.move(at.x, at.y);
  await expect.poll(selected).toBe(2);

  // The keyboard takes it back; typing re-renders the rows under the still
  // pointer, and the browser's follow-up mousemove at the same spot (sent
  // here by hand — headless browsers don't) must not take it again.
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.type("i");
  await expect.poll(selected).toBe(0);
  await rows.nth(2).dispatchEvent("mousemove", { clientX: at.x, clientY: at.y, bubbles: true });
  await page.waitForTimeout(200);
  expect(await selected()).toBe(0);
});

test("an unknown directive is sent as the text it is", async ({ page }) => {
  await setupTestDatabase(page, "directives-unknown");
  await startMockSession(page, "/workspace/directives-unknown", {
    configOptions: [modelOption],
  });
  await composer(page).click();
  await page.keyboard.type("try @model:nope please");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Enter");
  await settled(page, 1);

  expect(await lastWireSet(page, "session/set_config_option")).toBeNull();
  const { prompt: blocks } = await lastWirePrompt(page);
  expect(blocks[0]).toEqual({ type: "text", text: "try @model:nope please" });
});

test("in the widget, a model picked from the harness's catalog applies to a new session", async ({
  page,
}) => {
  const workspacePath = "/workspace/directives-widget";
  await setupTestDatabase(page, "directives-widget");
  const editor = await openDocument(page, workspacePath, "doc.md", "# Doc\n\nText.\n");
  // What an earlier session reported: the catalog every harness keeps.
  await page.evaluate(async (option) => {
    const { harnesses } = (window as any).__notefigCore;
    await harnesses.ready();
    for (const { id } of harnesses.configured()) {
      await harnesses.harness(id).recordOffer({ configOptions: [option] });
    }
  }, modelOption);
  await page.evaluate(
    (option) =>
      (window as any).__mockAgent.configure({
        scenario: "echo",
        session: { configOptions: [option] },
      }),
    modelOption,
  );
  const widget = await summonWidget(page, editor);

  await pick(page, "@model:son", "Sonnet");
  await expect(widget).toContainText("@model: Sonnet");
  const before = (await collectionStats(page)).settledTurns;
  await sendWidgetPrompt(page, widget, "shorten it");
  await settled(page, before + 1);

  expect(await lastWireSet(page, "session/set_config_option")).toMatchObject({
    value: "sonnet",
  });
  const { prompt: blocks } = await lastWirePrompt(page);
  expect(blocks.find((block) => block.type === "text")?.text).not.toContain("@model");
});
