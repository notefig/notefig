/* eslint-disable @typescript-eslint/no-explicit-any */
// Reference shots of the TS app's agent UI, driven through the mock harness
// (VITE_AGENT_MOCK=1) the way tests/agent/*.spec.ts do.
import { test, expect, type Page } from "@playwright/test";
import { shot } from "./helpers";
import { setupTestDatabase } from "/Users/parsa/Documents/notefig/packages/desktop/tests/setup/test-helpers";
import { readFileSync } from "fs";
import { openWorkspace, seedTestFiles, waitForFileTree, openFileInTree } from "/Users/parsa/Documents/notefig/packages/desktop/tests/setup/test-helpers";

// Copied from tests/agent/agent-helpers.ts (an ES module this CJS spec can't import).
const FIXTURES = "/Users/parsa/Documents/notefig/packages/desktop/tests/agent/fixtures/";
const composer = (page: Page) => page.locator('.prompt-editor [role="textbox"]');
const sessionRows = (page: Page) => page.locator("[data-session-row]");
const permissionCard = (page: Page) => page.locator("[data-permission-card]");
const configPicker = (page: Page, id: string) => page.locator(`[data-session-config="${id}"]`);
const toolCards = (page: Page, title: string) => page.locator(`[data-tool-call][data-tool-title="${title}"]`);
const widgets = (page: Page) => page.locator('[data-type="ai-prompt"]').locator("visible=true");
const stats = (page: Page) => page.evaluate(() => (window as any).__mockAgent.stats());
const loadRecording = (name: string) => JSON.parse(readFileSync(FIXTURES + name, "utf8"));
const promptTextOf = (rec: any, turn = 0) =>
  rec.turns[turn].prompt.filter((b: any) => b.type === "text").map((b: any) => b.text ?? "").join("\n");
const replayRecording = (page: Page, recording: any, options: Record<string, unknown> = {}) =>
  page.evaluate(({ recording, options }) => (window as any).__mockAgent.replay(recording, options), { recording, options });
const working = (page: Page) => page.getByRole("status").filter({ hasText: "Working" });
const waitForRunning = (page: Page) => working(page).waitFor({ state: "visible", timeout: 15000 });

async function startMockSession(page: Page, ws: string, session?: unknown, commands?: unknown) {
  await openWorkspace(page, ws);
  await page.goto("/?sidebarView=sessions");
  if (session || commands) {
    await page.evaluate(({ session, commands }) =>
      (window as any).__mockAgent.configure({ scenario: "echo", session, commands }), { session, commands });
  }
  await page.getByRole("button", { name: /New session with/ }).first().click();
  await page.getByRole("button", { name: "Trust & start" }).click();
  await composer(page).waitFor({ timeout: 15000 });
}
async function sendPrompt(page: Page, text: string) {
  await composer(page).fill(text);
  await composer(page).press("Enter");
}
async function sendAndSettle(page: Page, text: string) {
  const before = (await stats(page)).settledTurns;
  await sendPrompt(page, text);
  await expect.poll(async () => (await stats(page)).settledTurns, { timeout: 60000 }).toBe(before + 1);
  await working(page).waitFor({ state: "hidden", timeout: 60000 });
}
async function openDocument(page: Page, ws: string, fileName: string, content: string) {
  await openWorkspace(page, ws);
  await seedTestFiles(page, [{ path: `${ws}/${fileName}`, content, type: "file" as const }]);
  await page.reload();
  await waitForFileTree(page, fileName);
  await openFileInTree(page, fileName);
  const editor = page.locator(".ProseMirror").locator("visible=true").first();
  await editor.waitFor();
  return editor;
}
async function summonWidget(page: Page, editor: ReturnType<Page["locator"]>) {
  await editor.locator("p").first().click({ position: { x: 1, y: 8 } });
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowUp");
  await page.waitForTimeout(300);
  await page.keyboard.type("/");
  const widget = widgets(page).first();
  await expect(widget).toBeVisible({ timeout: 10000 });
  return widget;
}

test.setTimeout(120_000);

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
const effortOption = {
  id: "effort",
  name: "Effort",
  category: "thought_level",
  type: "select",
  currentValue: "high",
  options: [
    { value: "low", name: "Low" },
    { value: "medium", name: "Medium" },
    { value: "high", name: "High" },
  ],
};
const commands = [{ name: "review", description: "Review the branch" }];

const uniq = (name: string) => `ref-agents-${name}-${Date.now()}`;

async function newSession(page: Page) {
  await page.getByRole("button", { name: /New session with/ }).first().click();
  const trust = page.getByRole("button", { name: "Trust & start" });
  if (await trust.isVisible({ timeout: 1500 }).catch(() => false)) await trust.click();
  await composer(page).waitFor({ timeout: 15000 });
}

test("sessions + echo chat", async ({ page }) => {
  await setupTestDatabase(page, uniq("sessions"));
  await startMockSession(page, "/workspace/demo");
  await sendAndSettle(page, "What does this workspace contain?");
  await newSession(page);
  await sendAndSettle(page, "Summarize the README");
  await newSession(page);
  await replayRecording(page, loadRecording("streaming-slow.json"), { speed: 0.2, maxDelayMs: 5000 });
  await sendPrompt(page, "Explain the architecture at length");
  await waitForRunning(page);
  await expect(sessionRows(page)).toHaveCount(3);
  await shot(page, "agents-01-sessions");
});

test("echo chat", async ({ page }) => {
  await setupTestDatabase(page, uniq("echo"));
  await startMockSession(page, "/workspace/demo");
  await sendAndSettle(page, "Hello! Can you **echo** this back?");
  await page.waitForTimeout(1200);
  await shot(page, "agents-02-chat-echo");
});

test("chat with tools", async ({ page }) => {
  await setupTestDatabase(page, uniq("tools"));
  await startMockSession(page, "/workspace/demo");
  const rec = loadRecording("claude-todo.json");
  await replayRecording(page, rec);
  await sendAndSettle(page, promptTextOf(rec, 0));
  // Expand the thought and the Edit card so the diff shows.
  await page.locator("[data-thought] summary").first().click();
  const edit = toolCards(page, "Edit").first();
  const toggle = edit.locator("[data-diff-toggle]").first();
  await toggle.click();
  await edit.locator("diffs-container").first().waitFor({ timeout: 10000 });
  await page.waitForTimeout(800);
  await edit.scrollIntoViewIfNeeded();
  await shot(page, "agents-03-chat-tools");
});

test("permission card", async ({ page }) => {
  await setupTestDatabase(page, uniq("perm"));
  await startMockSession(page, "/workspace/demo");
  const rec = loadRecording("permission-reject-only.json");
  await replayRecording(page, rec);
  await sendPrompt(page, promptTextOf(rec));
  await expect(permissionCard(page)).toBeVisible({ timeout: 15000 });
  await shot(page, "agents-04-permission");
});

test("composer menu + session config", async ({ page }) => {
  await setupTestDatabase(page, uniq("config"));
  await startMockSession(page, "/workspace/demo", { configOptions: [modelOption, effortOption] }, commands);
  await expect(configPicker(page, "model")).toBeVisible();
  await shot(page, "agents-06-session-config");
  await configPicker(page, "model").click();
  await shot(page, "agents-06b-session-config-open");
  await page.keyboard.press("Escape");
  await composer(page).click();
  await page.keyboard.type("@");
  await expect(page.getByRole("listbox")).toBeVisible();
  await shot(page, "agents-05-composer-menu");
});

test("prompt widget", async ({ page }) => {
  await setupTestDatabase(page, uniq("widget"));
  const editor = await openDocument(page, "/workspace/demo", "notes.md", "# Notes\n\npara one\n\npara two\n");
  const rec = loadRecording("widget-answer.json");
  await replayRecording(page, rec);
  const widget = await summonWidget(page, editor);
  await page.keyboard.type(promptTextOf(rec, 0));
  await shot(page, "agents-08-prompt-widget-composing");
  await page.keyboard.press("Enter");
  const gate = widget.getByText("Press Enter again");
  if (await gate.isVisible().catch(() => false)) await page.keyboard.press("Enter");
  await expect(widgets(page).first().locator("[data-blob-phase]")).toHaveAttribute("data-blob-phase", "done", { timeout: 30000 });
  await shot(page, "agents-07-prompt-widget");
});

test("harness settings", async ({ page }) => {
  await setupTestDatabase(page, uniq("settings"));
  await startMockSession(page, "/workspace/demo");
  await page.goto(`${new URL(page.url()).pathname}?settings=harnesses`);
  await page.locator('[data-settings-section="harnesses"]').waitFor();
  await page.waitForTimeout(1000);
  await shot(page, "agents-09-harness-settings");
});
