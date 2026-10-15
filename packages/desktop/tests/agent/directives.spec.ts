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
  await menu(page).getByRole("option", { name: "@model:" }).click();
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
