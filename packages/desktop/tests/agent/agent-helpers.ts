/**
 * Helpers for agent-chat e2e specs: drive a mock-harness session
 * (VITE_AGENT_MOCK=1, see src/agent/mock-harness.ts) through the real UI,
 * and play back / capture session recordings (src/components/debug-panel-recording.ts).
 */
import { test, expect, type Locator, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  openFileInTree,
  openWorkspace,
  seedTestFiles,
  waitForFileTree,
} from "../setup/test-helpers";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ─── Sessions ───────────────────────────────────────────────────────────────

/** Open the workspace's sessions sidebar and start a mock-harness session. */
export async function startMockSession(
  page: Page,
  workspacePath: string,
  /** Extra `session/new` answer fields the mock agent advertises — `modes`,
   *  `models`, `configOptions` — for the session-settings pickers (MET-81). */
  session?: Record<string, unknown>,
): Promise<void> {
  await openWorkspace(page, workspacePath);
  // The open set is persisted, so a reload with the sessions view in the
  // URL comes back into the same workspace.
  await page.goto("/?sidebarView=sessions");
  if (session) {
    await page.evaluate(
      (session) =>
        (window as any).__mockAgent.configure({ scenario: "echo", session }),
      session,
    );
  }
  await page
    .getByRole("button", { name: /New session with/ })
    .first()
    .click();
  await page.getByRole("button", { name: "Trust & start" }).click();
  await composer(page).waitFor({ timeout: 15000 });
}

/** A session row in the sidebar (`data-session-row` = taskId). */
export function sessionRows(page: Page) {
  return page.locator("[data-session-row]");
}

// ─── Composer ───────────────────────────────────────────────────────────────

/** The prompt composer's editable surface (a Tiptap editor since MET-80). */
export function composer(page: Page) {
  return page.locator('.prompt-editor [role="textbox"]');
}

export async function sendPrompt(page: Page, text: string): Promise<void> {
  await composer(page).fill(text);
  await composer(page).press("Enter");
}

/**
 * Send a prompt and wait for its turn to settle. Counts settled turn rows
 * rather than watching the "Working…" shimmer: a flat-out replay finishes
 * in a few ms, before a locator can ever see the indicator.
 */
export async function sendAndSettle(page: Page, text: string): Promise<void> {
  const before = (await collectionStats(page)).settledTurns;
  await sendPrompt(page, text);
  await expect
    .poll(async () => (await collectionStats(page)).settledTurns, {
      timeout: 60_000,
    })
    .toBe(before + 1);
  await waitForIdle(page);
}

/** The composer's morphing action button, by its current mode. */
export function composerButton(page: Page, mode: "send" | "queue" | "stop") {
  const name = { send: "Send (⏎)", queue: "Queue (⏎)", stop: "Stop" }[mode];
  return page.getByRole("button", { name, exact: true });
}

// ─── Scenarios + recordings ─────────────────────────────────────────────────

export async function configureScenario(
  page: Page,
  scenario: string,
  options: Record<string, unknown>,
): Promise<void> {
  await page.evaluate(
    ({ scenario, options }) =>
      (window as any).__mockAgent.configure({ scenario, options }),
    { scenario, options },
  );
}

/** A recording in the notefig-agent-recording format (see fixtures/README). */
export type AgentRecordingFixture = {
  format: "notefig-agent-recording";
  version: 1;
  harnessId: string;
  taskId: string;
  workspacePath: string;
  turns: Array<{
    prompt: Array<{ type: string; text?: string; uri?: string }>;
    events: Array<{ kind: string; at: number; [key: string]: unknown }>;
    stopReason?: string;
    error?: { code: number; message: string };
  }>;
  [key: string]: unknown;
};

/** Read a fixture from tests/agent/fixtures/ (relative to the running spec's
 *  directory, so it works from any cwd). */
export function loadRecording(name: string): AgentRecordingFixture {
  const file = join(dirname(test.info().file), "fixtures", name);
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  if (parsed?.format !== "notefig-agent-recording") {
    throw new Error(`${name} is not a notefig-agent-recording`);
  }
  return parsed as AgentRecordingFixture;
}

/** Make every following mock turn replay the recording (turns in order). */
export async function replayRecording(
  page: Page,
  recording: AgentRecordingFixture,
  options: { turn?: number; speed?: number; maxDelayMs?: number } = {},
): Promise<void> {
  await page.evaluate(
    ({ recording, options }) =>
      (window as any).__mockAgent.replay(recording, options),
    { recording, options },
  );
}

/** The text of a recorded turn's prompt — what a test types to play it. */
export function promptTextOf(
  recording: AgentRecordingFixture,
  turn = 0,
): string {
  return recording.turns[turn].prompt
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
}

/** The last `session/prompt` the mock agent received — the prompt as it
 *  went on the wire (text + resource_link parts). */
export async function lastWirePrompt(
  page: Page,
): Promise<{ prompt: Array<{ type: string; text?: string; uri?: string }> }> {
  return page.evaluate(() => (window as any).__mockAgent.lastPrompt());
}

/**
 * The session as a recording, the way a person gets it: the debug panel
 * (a URL param, pushed without a reload so the page state survives),
 * Session tab, pick the task, click Recording, read the clipboard — the
 * panel re-shapes the transcript rows (debug-panel-recording.ts). Callers need
 * `context.grantPermissions(["clipboard-read", "clipboard-write"])`.
 */
export async function exportRecording(page: Page): Promise<AgentRecordingFixture> {
  await page.evaluate(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get("debug") !== "true") {
      url.searchParams.set("debug", "true");
      window.history.pushState({}, "", url);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }
  });
  // The tab button carries a task-count badge ("Session(1)") — anchored on
  // the badge so the sidebar's icon-only "Sessions" tool tab can't match.
  await page.getByRole("button", { name: /^Session\(\d+\)$/ }).click();
  await page.locator("select").last().selectOption({ index: 0 });
  const button = page.getByTestId("copy-agent-recording");
  await expect(button).toBeEnabled();
  await button.click();
  const json = await page.evaluate(() => navigator.clipboard.readText());
  const parsed = JSON.parse(json);
  expect(parsed?.format, "a notefig-agent-recording on the clipboard").toBe(
    "notefig-agent-recording",
  );
  return parsed as AgentRecordingFixture;
}

// ─── Turn state ─────────────────────────────────────────────────────────────

/** The "Working…" shimmer is the turn-running signal. Filtered by text so
 *  other live regions (sonner's toaster) can't collide with the locator. */
function workingIndicator(page: Page) {
  return page.getByRole("status").filter({ hasText: "Working" });
}

export async function waitForRunning(page: Page): Promise<void> {
  await workingIndicator(page).waitFor({ state: "visible", timeout: 15000 });
}

export async function waitForIdle(
  page: Page,
  timeoutMs = 120_000,
): Promise<void> {
  await workingIndicator(page).waitFor({ state: "hidden", timeout: timeoutMs });
}

export async function collectionStats(page: Page): Promise<{
  tasks: number;
  turns: number;
  settledTurns: number;
  entries: number;
}> {
  return page.evaluate(() => (window as any).__mockAgent.stats());
}

// ─── Transcript locators (the data-* hooks on the chat tab) ─────────────────

export function transcript(page: Page) {
  return page.locator("[data-transcript-viewport]");
}

/** Mounted transcript rows of one entry type
 *  (user | assistant | thought | tool_call | plan | turn_error). */
export function entries(page: Page, type: string) {
  return page.locator(`[data-entry-type="${type}"]`);
}

export function planCard(page: Page) {
  return page.locator("[data-plan]");
}

export function planEntries(page: Page) {
  return page.locator("[data-plan-entry]");
}

/** Statuses of the plan's entries, top to bottom. */
export async function planStatuses(page: Page): Promise<string[]> {
  return planEntries(page).evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute("data-plan-status") ?? ""),
  );
}

export function toolCards(page: Page, title?: string) {
  return title
    ? page.locator(`[data-tool-call][data-tool-title="${title}"]`)
    : page.locator("[data-tool-call]");
}

export function permissionCard(page: Page) {
  return page.locator("[data-permission-card]");
}

export function authCard(page: Page) {
  return page.locator("[data-auth-card]");
}

// ─── The in-document prompt widget ──────────────────────────────────────────

/** Seed a document, open the workspace, open the doc; returns the editor. */
export async function openDocument(
  page: Page,
  workspacePath: string,
  fileName: string,
  content: string,
): Promise<Locator> {
  await openWorkspace(page, workspacePath);
  await seedTestFiles(page, [
    { path: `${workspacePath}/${fileName}`, content, type: "file" as const },
  ]);
  await page.reload();
  await waitForFileTree(page, fileName);
  await openFileInTree(page, fileName);
  const editor = page.locator(".ProseMirror").locator("visible=true").first();
  await editor.waitFor();
  return editor;
}

export function widgets(page: Page) {
  return page.locator('[data-type="ai-prompt"]').locator("visible=true");
}

/** Summon a widget on a fresh paragraph at the top of the document via "/". */
export async function summonWidget(page: Page, editor: Locator): Promise<Locator> {
  await editor.locator("p").first().click({ position: { x: 1, y: 8 } });
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowUp");
  await page.waitForTimeout(300);
  await page.keyboard.type("/");
  const widget = widgets(page).first();
  await expect(widget).toBeVisible({ timeout: 10000 });
  return widget;
}

/** Type a prompt into the focused widget draft and send it, passing the
 *  workspace trust gate on first use (Enter arms, Enter confirms). */
export async function sendWidgetPrompt(
  page: Page,
  widget: Locator,
  text: string,
): Promise<void> {
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
  const trustGate = widget.getByText("Press Enter again");
  if (await trustGate.isVisible().catch(() => false)) {
    await page.keyboard.press("Enter");
  }
}

// ─── Session settings (MET-81) ──────────────────────────────────────────────

/** The composer's picker for one session setting (`data-session-config` = option id). */
export function configPicker(page: Page, optionId: string) {
  return page.locator(`[data-session-config="${optionId}"]`);
}

/** The params the mock agent captured for a `session/set_*` method. */
export async function lastWireSet(
  page: Page,
  method: string,
): Promise<Record<string, unknown> | null> {
  return page.evaluate(
    (method) => (window as any).__mockAgent.lastSet(method),
    method,
  );
}
