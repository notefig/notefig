/**
 * Every agent-facing component and workflow, driven by recorded sessions.
 *
 * Each test plays a recording from ./fixtures (the notefig-agent-recording
 * format, see fixtures/README.md) through the mock harness: the real ACP
 * client, agent service, collections, chat tab and prompt widget run; only
 * the process on the far side of the transport is scripted. A janky
 * component reproduced with a real harness is captured from the debug
 * panel ("Recording"), dropped into fixtures/, and gets a test here.
 *
 * Runs in the `agent` Playwright project (VITE_AGENT_MOCK=1):
 *   npx playwright test --project=agent tests/agent/agent-workflows.spec.ts
 */
import { test, expect, type Page } from "@playwright/test";
import {
  openFileInTree,
  openWorkspace,
  seedTestFiles,
  setupTestDatabase,
} from "../setup/test-helpers";
import {
  authCard,
  composer,
  composerButton,
  collectionStats,
  configPicker,
  lastWireSet,
  entries,
  exportRecording,
  lastWirePrompt,
  loadRecording,
  openDocument,
  permissionCard,
  planCard,
  planEntries,
  planStatuses,
  promptTextOf,
  replayRecording,
  sendAndSettle,
  sendPrompt,
  sendWidgetPrompt,
  sessionRows,
  startMockSession,
  summonWidget,
  toolCards,
  waitForIdle,
  waitForRunning,
  widgets,
} from "./agent-helpers";

/** A fresh DB + workspace + mock session, replaying the given fixture. */
async function sessionWith(
  page: Page,
  name: string,
  fixture: string,
  options: { speed?: number; maxDelayMs?: number } = {},
) {
  await setupTestDatabase(page, `workflows-${name}`);
  const workspacePath = `/workspace/workflows-${name}`;
  await startMockSession(page, workspacePath);
  const recording = loadRecording(fixture);
  await replayRecording(page, recording, options);
  return { workspacePath, recording };
}

/** The virtual row index a locator's transcript row sits at. */
async function rowIndex(locator: ReturnType<Page["locator"]>) {
  return locator
    .first()
    .locator("xpath=ancestor::*[@data-index][1]")
    .getAttribute("data-index")
    .then((value) => Number(value));
}

test.describe("agent workflows", () => {
  test.setTimeout(90_000);

  // ── Transcript entries ────────────────────────────────────────────────

  test.describe("transcript", () => {
    test("user bubble and assistant markdown (bold, list, code) render", async ({
      page,
    }) => {
      const { recording } = await sessionWith(page, "markdown", "claude-todo.json");
      await sendAndSettle(page, promptTextOf(recording));

      await expect(entries(page, "user")).toContainText(promptTextOf(recording));
      const assistant = entries(page, "assistant").last();
      await expect(assistant).toContainText("discriminated union");
      await expect(assistant.locator("strong")).toContainText("discriminated union");
      await expect(assistant.locator("li")).toHaveCount(2);
      await expect(assistant.locator("pre code")).toContainText("resolveWorkspacePath(input)");
    });

    test("thinking is collapsed by default and expands on click", async ({
      page,
    }) => {
      const { recording } = await sessionWith(page, "thought", "claude-todo.json");
      await sendAndSettle(page, promptTextOf(recording));

      const thought = page.locator("[data-thought]").first();
      await expect(thought).toBeVisible();
      await expect(thought).not.toHaveAttribute("open", "");
      await expect(thought.locator("p")).toBeHidden();
      await thought.locator("summary").click();
      await expect(thought.locator("p")).toContainText("track this with a todo list");
    });

    test("a tool call reaches its terminal status and expands to its output", async ({
      page,
    }) => {
      const { recording } = await sessionWith(page, "tool", "claude-todo.json");
      await sendAndSettle(page, promptTextOf(recording));

      const read = toolCards(page, "Read").first();
      await expect(read).toHaveAttribute("data-tool-status", "completed");
      await expect(read).toHaveAttribute("data-tool-kind", "read");
      await expect(read).toHaveAttribute("data-tool-open", "false");
      await read.locator("button").first().click();
      await expect(read).toHaveAttribute("data-tool-open", "true");
      await expect(read).toContainText("export function resolveWorkspacePath");

      // An execute call previews its command inline.
      const bash = toolCards(page, "Bash").first();
      await expect(bash).toContainText("npx vitest run src/resolver.test.ts");
      await expect(bash).toHaveAttribute("data-tool-status", "completed");
    });

    test("diff-bearing tool calls render the changed-files card; terminal content names its terminal", async ({
      page,
    }) => {
      const { recording } = await sessionWith(page, "diffs", "changed-files.json");
      await sendAndSettle(page, promptTextOf(recording));

      const card = toolCards(page, "MultiEdit").first();
      await expect(card).toHaveAttribute("data-tool-diffs", "3");
      await expect(card).toContainText("3 changed files");
      await expect(card.locator("[data-diff-path]")).toHaveCount(3);
      const newFile = card.locator('[data-diff-path$="new-bar.ts"]');
      await expect(newFile).toContainText("new-bar.ts");
      await newFile.locator("button").click();
      await expect(newFile.locator("pre")).toContainText("export const bar = new Bar();");

      const terminal = toolCards(page, "Bash").first();
      await terminal.locator("button").first().click();
      await expect(terminal).toContainText("Terminal term_42");
    });

    test("a failed tool call opens by default with its error", async ({
      page,
    }) => {
      const { recording } = await sessionWith(page, "tool-fail", "tool-failure.json");
      await sendAndSettle(page, promptTextOf(recording));

      const card = toolCards(page, "bash").first();
      await expect(card).toHaveAttribute("data-tool-status", "failed");
      await expect(card).toHaveAttribute("data-tool-open", "true");
      await expect(card).toContainText("error TS2322");
      await expect(entries(page, "assistant").last()).toContainText("Want me to fix it?");
    });

    test("author_blob renders the authored-blob card with a jump link", async ({
      page,
    }) => {
      const { recording } = await sessionWith(page, "blob", "author-blob.json");
      await sendAndSettle(page, promptTextOf(recording));

      const card = toolCards(page, "author_blob").first();
      await expect(card).toContainText("authored a question in");
      await expect(card.getByRole("button", { name: "notes.md" })).toBeVisible();
      await expect(card).toHaveAttribute("data-tool-status", "completed");
    });

    test("available_commands / current_mode updates are kept as data, never rendered", async ({
      page,
    }) => {
      const { recording } = await sessionWith(page, "unknown", "unknown-updates.json");
      await sendAndSettle(page, promptTextOf(recording));

      await expect(entries(page, "assistant").last()).toContainText("Mode set.");
      // user, unknown (available_commands), assistant in the collection —
      // current_mode_update is session state on the task row (MET-81), never
      // an entry…
      expect((await collectionStats(page)).entries).toBe(3);
      // …the unknown one is a row, but an empty one (kept as data only).
      const unknownTexts = await entries(page, "unknown").evaluateAll((nodes) =>
        nodes.map((node) => node.textContent?.trim() ?? ""),
      );
      expect(unknownTexts).toEqual([""]);
      await expect(entries(page, "user")).toHaveCount(1);
      await expect(entries(page, "assistant")).toHaveCount(1);
      // A harness that advertises no settings gets no pickers, and a mode
      // update for a session without a mode option changes nothing.
      await expect(page.locator("[data-session-config]")).toHaveCount(0);
    });

    test("session settings: pickers read the session's mode/model and switch them over the wire", async ({
      page,
    }) => {
      await setupTestDatabase(page, "workflows-settings");
      const workspacePath = "/workspace/workflows-settings";
      await startMockSession(page, workspacePath, {
        modes: {
          currentModeId: "default",
          availableModes: [
            { id: "default", name: "Default" },
            { id: "plan", name: "Plan", description: "Read-only planning" },
          ],
        },
        models: {
          currentModelId: "sonnet",
          availableModels: [
            { modelId: "sonnet", name: "Sonnet" },
            { modelId: "opus", name: "Opus" },
          ],
        },
      });

      const model = configPicker(page, "model");
      await expect(model).toHaveText(/Sonnet/);
      // Modes are tracked but parked out of the toolbar for now.
      await expect(configPicker(page, "mode")).toHaveCount(0);

      // Switch the model: the choice goes out as the unstable set_model and
      // the trigger follows.
      await model.click();
      await page.locator('[data-session-config-choice="opus"]').click();
      await expect(model).toHaveText(/Opus/);
      // Closing the menu hands focus back to the composer, not the trigger.
      await expect(composer(page)).toBeFocused();

      // Keyboard path: a focused trigger opens on Enter, and the list is
      // navigable without a pointer.
      await model.focus();
      await page.keyboard.press("Enter");
      await expect(page.locator('[data-session-config-choice="sonnet"]')).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(composer(page)).toBeFocused();
      expect(await lastWireSet(page, "session/set_model")).toEqual({
        sessionId: expect.any(String),
        modelId: "opus",
      });

      // The agent moving its own mode mid-turn stays row state (no entry)
      // and still doesn't surface a mode picker.
      const recording = loadRecording("unknown-updates.json");
      await replayRecording(page, recording);
      await sendAndSettle(page, promptTextOf(recording));
      expect((await collectionStats(page)).entries).toBe(3);
      await expect(configPicker(page, "mode")).toHaveCount(0);
      await expect(model).toHaveText(/Opus/);
    });

    test("a turn that errors keeps its partial text and shows the error banner", async ({
      page,
    }) => {
      const { recording } = await sessionWith(page, "turn-error", "turn-error.json");
      await sendAndSettle(page, promptTextOf(recording));

      await expect(entries(page, "assistant").last()).toContainText("three layers");
      const banner = entries(page, "turn_error");
      await expect(banner).toContainText("Turn failed:");
      await expect(banner).toContainText("model overloaded");
      // The composer is usable again.
      await expect(composer(page)).toBeEditable();
    });
  });

  // ── The plan / todo component ─────────────────────────────────────────

  test.describe("plan (todo list)", () => {
    test("Claude Code TodoWrite: one live plan per turn, replaced in place, ending fully completed", async ({
      page,
    }) => {
      const { recording } = await sessionWith(page, "claude-todo", "claude-todo.json");
      await sendAndSettle(page, promptTextOf(recording, 0));

      // Four plan updates in the turn → ONE card (ACP: the client replaces
      // the entire plan with each update), holding the last snapshot.
      await expect(planCard(page)).toHaveCount(1);
      await expect(planEntries(page)).toHaveCount(3);
      expect(await planStatuses(page)).toEqual(["completed", "completed", "completed"]);
      await expect(planCard(page)).toContainText("Run the unit tests");
      await expect(planEntries(page).first()).toHaveAttribute("data-plan-priority", "high");

      // The card sits where the FIRST update landed: before the Read tool.
      expect(await rowIndex(planCard(page))).toBeLessThan(
        await rowIndex(toolCards(page, "Read")),
      );

      // A later turn gets its own plan.
      await sendAndSettle(page, promptTextOf(recording, 1));
      await expect(planCard(page)).toHaveCount(2);
      await expect(planCard(page).last().locator("[data-plan-entry]")).toHaveCount(2);
      await expect(planCard(page).last()).toContainText("Add error-branch test");
    });

    test("Devin: a task list that shrinks between updates replaces, never accumulates", async ({
      page,
    }) => {
      const { recording } = await sessionWith(page, "devin-todo", "devin-todo.json");
      await sendAndSettle(page, promptTextOf(recording));

      await expect(planCard(page)).toHaveCount(1);
      await expect(planEntries(page)).toHaveCount(2);
      expect(await planStatuses(page)).toEqual(["completed", "completed"]);
      await expect(planCard(page)).toContainText("Add API client method + form submit");
      await expect(planCard(page)).not.toContainText("Manual QA");
    });

    test("the plan updates live while the turn streams", async ({ page }) => {
      const { recording } = await sessionWith(page, "plan-live", "claude-todo.json", {
        speed: 1,
        maxDelayMs: 150,
      });
      await sendPrompt(page, promptTextOf(recording, 0));
      await waitForRunning(page);

      // Mid-turn: one card, something in progress.
      await expect.poll(() => planStatuses(page), { timeout: 15_000 }).toContain(
        "in_progress",
      );
      await expect(planCard(page)).toHaveCount(1);

      await waitForIdle(page);
      await expect(planCard(page)).toHaveCount(1);
      expect(await planStatuses(page)).toEqual(["completed", "completed", "completed"]);
    });
  });

  // ── Composer ──────────────────────────────────────────────────────────

  test.describe("composer", () => {
    test("Stop cancels a streaming turn", async ({ page }) => {
      const { recording } = await sessionWith(page, "stop", "streaming-slow.json", {
        speed: 1,
      });
      await sendPrompt(page, promptTextOf(recording, 0));
      await waitForRunning(page);
      await expect(entries(page, "assistant")).toHaveCount(1, { timeout: 10_000 });

      await composerButton(page, "stop").click();
      await waitForIdle(page, 15_000);
      await expect(composerButton(page, "send")).toBeVisible();
      // Partial text stays (markdown renders off-thread, so retry until it
      // lands); the stream did not run to the end.
      const partial = entries(page, "assistant").last();
      await expect(partial).toContainText("Streaming");
      const text = await partial.textContent();
      expect(text!.length).toBeLessThan(
        "Streaming a long explanation so a test can interrupt it. ".repeat(12).length,
      );
    });

    test("Escape cancels the running turn and restores the prompt to the draft", async ({
      page,
    }) => {
      const { recording } = await sessionWith(page, "escape", "streaming-slow.json", {
        speed: 1,
      });
      const prompt = promptTextOf(recording, 0);
      await sendPrompt(page, prompt);
      await waitForRunning(page);
      await expect(composer(page)).toHaveText("");

      await composer(page).focus();
      await page.keyboard.press("Escape");
      await waitForIdle(page, 15_000);
      await expect(composer(page)).toHaveText(prompt);
    });

    test("a prompt sent mid-turn queues, shows the queued badge, then runs", async ({
      page,
    }) => {
      const { recording } = await sessionWith(page, "queue", "streaming-slow.json", {
        speed: 1,
      });
      await sendPrompt(page, promptTextOf(recording, 0));
      await waitForRunning(page);

      await composer(page).fill(promptTextOf(recording, 1));
      await expect(composerButton(page, "queue")).toBeEnabled();
      await composer(page).press("Enter");
      const badge = page.getByRole("button", { name: "Remove from queue" });
      await expect(badge).toBeVisible();

      await waitForIdle(page, 30_000);
      await expect(badge).toBeHidden();
      await expect(entries(page, "assistant").last()).toContainText("Short.");
      expect((await collectionStats(page)).turns).toBe(2);
    });

    test("a queued prompt can be withdrawn before it runs", async ({ page }) => {
      const { recording } = await sessionWith(page, "unqueue", "streaming-slow.json", {
        speed: 1,
      });
      await sendPrompt(page, promptTextOf(recording, 0));
      await waitForRunning(page);
      await sendPrompt(page, "never mind");
      const badge = page.getByRole("button", { name: "Remove from queue" });
      await expect(badge).toBeVisible();
      await badge.click();
      await expect(badge).toBeHidden();
      await expect(entries(page, "user")).toHaveCount(1);

      await waitForIdle(page, 30_000);
      expect((await collectionStats(page)).turns).toBe(1);
      await expect(entries(page, "assistant").last()).not.toContainText("Short.");
    });

    test("Shift+Enter inserts a newline instead of sending", async ({ page }) => {
      await sessionWith(page, "shift-enter", "unknown-updates.json");
      await composer(page).fill("line one");
      await composer(page).press("Shift+Enter");
      await page.keyboard.type("line two");
      await page.waitForTimeout(300);
      await expect(composer(page)).toContainText("line one");
      await expect(composer(page)).toContainText("line two");
      expect((await collectionStats(page)).turns).toBe(0);
    });

    test("an @-mention attaches the file as a resource_link on the wire", async ({
      page,
    }) => {
      await setupTestDatabase(page, "workflows-mention");
      const workspacePath = "/workspace/workflows-mention";
      // Seed the file first: the mention menu lists workspace files, and
      // starting the session navigates (a reload afterwards would drop the
      // chat tab, which rides the URL).
      await openWorkspace(page, workspacePath);
      await seedTestFiles(page, [
        { path: `${workspacePath}/docs/guide.md`, content: "# Guide\n", type: "file" as const },
      ]);
      await startMockSession(page, workspacePath);
      await replayRecording(page, loadRecording("unknown-updates.json"));
      // The mention menu reads the workspace metadata collection, which
      // hydrates lazily (MET-99) — the sessions view never touches it, so
      // show the file tree once (same page; the chat tab stays open).
      await page.getByRole("button", { name: "Files" }).click();
      await page.getByRole("treeitem", { name: "docs" }).first().waitFor({ timeout: 15_000 });

      await composer(page).click();
      await page.keyboard.type("see @gui");
      const menu = page.getByRole("listbox", { name: "Reference a file" });
      await expect(menu).toBeVisible({ timeout: 10_000 });
      await menu.getByRole("option").first().click();
      await page.keyboard.press("Enter");
      await expect
        .poll(async () => (await collectionStats(page)).settledTurns, {
          timeout: 60_000,
        })
        .toBe(1);

      const { prompt: blocks } = await lastWirePrompt(page);
      const link = blocks.find((block) => block.type === "resource_link");
      expect(link?.uri).toContain("guide.md");
      expect(blocks.some((block) => block.type === "text" && block.text?.includes("guide.md"))).toBe(true);
    });

    test("Copy message puts the assistant text on the clipboard", async ({
      page,
      context,
    }) => {
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
      const { recording } = await sessionWith(page, "copy", "tool-failure.json");
      await sendAndSettle(page, promptTextOf(recording));

      const assistant = entries(page, "assistant").last();
      await assistant.hover();
      await assistant.getByRole("button", { name: "Copy message" }).click();
      await expect
        .poll(() => page.evaluate(() => navigator.clipboard.readText()))
        .toContain("Want me to fix it?");
    });
  });

  // ── Permissions ───────────────────────────────────────────────────────

  test.describe("permissions", () => {
    test("a reject-only request shows the card; choosing settles the turn", async ({
      page,
      context,
    }) => {
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
      const { recording } = await sessionWith(page, "perm-reject", "permission-reject-only.json");
      await sendPrompt(page, promptTextOf(recording));
      await waitForRunning(page);

      const card = permissionCard(page);
      await expect(card).toBeVisible({ timeout: 15_000 });
      await expect(card).toContainText("Run rm -rf build/");
      await expect(card.getByRole("button", { name: "Never" })).toBeVisible();
      await card.getByRole("button", { name: "Not now" }).click();
      await expect(card).toBeHidden();

      await waitForIdle(page);
      await expect(toolCards(page, "Bash").first()).toHaveAttribute("data-tool-status", "failed");
      await expect(entries(page, "assistant").last()).toContainText("left the build directory alone");

      // The recording derived from the transcript carries the request
      // (its options verbatim) and that it was settled by a choice.
      const tape = await exportRecording(page);
      const request = tape.turns[0].events.find((e) => e.kind === "request") as
        | { params: { options: Array<{ optionId: string }> }; response?: { outcome?: { outcome?: string } } }
        | undefined;
      expect(request?.params.options.map((o) => o.optionId)).toEqual(["reject_once", "reject_always"]);
      expect(request?.response?.outcome?.outcome).toBe("selected");
    });

    test("a request offering an allow option is granted silently", async ({
      page,
      context,
    }) => {
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
      const { recording } = await sessionWith(page, "perm-allow", "permission-auto-grant.json");
      await sendAndSettle(page, promptTextOf(recording));

      await expect(permissionCard(page)).toHaveCount(0);
      await expect(toolCards(page, "Write").first()).toHaveAttribute("data-tool-status", "completed");
      // The blanket grant answers inside the client — no permission row is
      // ever published, so the session's recording shows no request either.
      const tape = await exportRecording(page);
      expect(tape.turns[0].events.some((e) => e.kind === "request")).toBe(false);
    });
  });

  // ── Auth ──────────────────────────────────────────────────────────────

  test.describe("auth", () => {
    test("sign-in required holds the prompt; retry after sign-in runs it", async ({
      page,
    }) => {
      const { recording } = await sessionWith(page, "auth", "auth-required.json");
      await sendPrompt(page, promptTextOf(recording, 0));

      const card = authCard(page);
      await expect(card).toBeVisible({ timeout: 15_000 });
      await expect(card).toContainText("Sign-in required");
      await expect(sessionRows(page).first()).toContainText("needs sign-in");

      await card.getByRole("button", { name: "I've signed in — retry" }).click();
      await waitForIdle(page);
      await expect(card).toBeHidden();
      await expect(entries(page, "assistant").last()).toContainText("Signed in and ready.");
      // The held prompt ran once — not re-inserted as a second user bubble.
      await expect(entries(page, "user")).toHaveCount(1);
    });
  });

  // ── Sessions sidebar ──────────────────────────────────────────────────

  test.describe("sessions", () => {
    test("the row reflects the task status and its stop button cancels", async ({
      page,
    }) => {
      const { recording } = await sessionWith(page, "row", "streaming-slow.json", {
        speed: 1,
      });
      const row = sessionRows(page).first();
      await expect(row).toHaveAttribute("data-session-status", "idle");
      await sendPrompt(page, promptTextOf(recording, 0));
      await expect(row).toHaveAttribute("data-session-status", "running");

      // The stop button is `hidden group-hover:block`: in a headed window
      // the physical cursor's hover state overrides the synthetic one, so
      // fire the click on the (CSS-hidden) button rather than hover-then-click.
      await row.hover();
      await row
        .getByRole("button", { name: "Stop session", includeHidden: true })
        .dispatchEvent("click");
      await waitForIdle(page, 15_000);
      await expect(row).toHaveAttribute("data-session-status", "cancelled");
    });

    test("context menu: copy session id, refresh from the harness, delete", async ({
      page,
      context,
    }) => {
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
      const { recording } = await sessionWith(page, "menu", "tool-failure.json");
      await sendAndSettle(page, promptTextOf(recording));
      const row = sessionRows(page).first();

      await row.click({ button: "right" });
      await page.getByRole("menuitem", { name: "Copy session ID" }).click();
      await expect
        .poll(() => page.evaluate(() => navigator.clipboard.readText()))
        .toMatch(/^mock_session_\d+$/);

      // Refresh replays the harness's stored history: same transcript back.
      const before = await collectionStats(page);
      await row.click({ button: "right" });
      await page.getByRole("menuitem", { name: "Refresh session" }).click();
      await expect.poll(() => collectionStats(page), { timeout: 15_000 }).toMatchObject({
        entries: before.entries,
      });
      await expect(entries(page, "user")).toContainText(promptTextOf(recording));
      await expect(entries(page, "assistant").last()).toContainText("Want me to fix it?");

      await row.click({ button: "right" });
      await page.getByRole("menuitem", { name: "Delete session" }).click();
      await expect(sessionRows(page)).toHaveCount(0);
      await expect(composer(page)).toHaveCount(0);
    });
  });

  // ── Attention: what the sidebar points the user at ────────────────────

  test.describe("attention", () => {
    test("a turn that settles out of view marks its session; opening the session clears it", async ({
      page,
    }) => {
      await setupTestDatabase(page, "workflows-attention");
      const workspacePath = "/workspace/workflows-attention";
      await openWorkspace(page, workspacePath);
      await seedTestFiles(page, [
        { path: `${workspacePath}/notes.md`, content: "# notes\n", type: "file" },
      ]);
      await startMockSession(page, workspacePath);
      // Paced so the turn is still running when the user looks away.
      const recording = loadRecording("streaming-slow.json");
      await replayRecording(page, recording, { speed: 0.1, maxDelayMs: 3_000 });
      const sessionGlyph = () =>
        sessionRows(page).first().locator("[data-status-glyph]");
      // The header row renders twice (the card and its collapsed strip);
      // both carry the same one dot, so any visible one will do.
      const headerGlyph = page
        .locator(`button[title="${workspacePath}"]:visible [data-status-glyph]`)
        .first();

      // Settling under the user's eyes is seen as it lands: no mark.
      await sendAndSettle(page, promptTextOf(recording, 0));
      await expect(sessionGlyph()).toHaveAttribute("data-status-glyph", "idle");
      await expect(headerGlyph).toHaveCount(0);

      // Send, then look away while it runs.
      const before = (await collectionStats(page)).settledTurns;
      await sendPrompt(page, "again");
      await page.getByRole("button", { name: "Files", exact: true }).click();
      await openFileInTree(page, "notes.md");
      await expect
        .poll(async () => (await collectionStats(page)).settledTurns, { timeout: 60_000 })
        .toBe(before + 1);

      // The session is marked, and the sidebar's one dot agrees (blue: BAU).
      await page.getByRole("button", { name: "Sessions", exact: true }).click();
      await expect(sessionGlyph()).toHaveAttribute("data-status-glyph", "attention-bau");
      await expect(headerGlyph).toHaveAttribute("data-status-glyph", "attention-bau");

      // Looking at it is what clears it.
      await sessionRows(page).first().click();
      await expect(sessionGlyph()).toHaveAttribute("data-status-glyph", "idle");
      await expect(headerGlyph).toHaveCount(0);
    });
  });

  // ── The in-document prompt widget ─────────────────────────────────────

  test.describe("prompt widget", () => {
    const DOC = "para one\n\npara two\n";

    test("answer: summon, send through the trust gate, done face shows the widget_respond answer; reply flags an issue", async ({
      page,
    }) => {
      await setupTestDatabase(page, "workflows-widget-answer");
      const editor = await openDocument(page, "/workspace/workflows-widget-answer", "notes.md", DOC);
      const recording = loadRecording("widget-answer.json");
      await replayRecording(page, recording);

      const widget = await summonWidget(page, editor);
      await sendWidgetPrompt(page, widget, promptTextOf(recording, 0));
      const face = widget.locator("[data-blob-phase]");
      await expect(face).toHaveAttribute("data-blob-phase", "done", { timeout: 30_000 });
      await expect(face).toHaveAttribute("data-blob-response", "answer");
      await expect(widget).toContainText("Summary");
      await expect(widget).toContainText("Two short paragraphs");
      await expect(widget.locator("strong")).toContainText("nothing in particular");

      // Reply continuation: the same hole, now a reply.
      const draft = widget.locator("[data-prompt-draft]");
      await expect(draft).toHaveAttribute("data-placeholder", "Reply…");
      await draft.click();
      await page.keyboard.type(promptTextOf(recording, 1));
      await page.keyboard.press("Enter");
      // (A flat-out replay is done before "running" can be observed; the
      // response kind flipping to "issue" is the proof the reply round ran.)
      await expect(face).toHaveAttribute("data-blob-response", "issue", { timeout: 30_000 });
      await expect(face).toHaveAttribute("data-blob-phase", "done");
      await expect(widget).toContainText("can't tell which paragraph");
    });

    test("Open chat from a done widget opens the session's chat tab", async ({
      page,
    }) => {
      await setupTestDatabase(page, "workflows-widget-open");
      const editor = await openDocument(page, "/workspace/workflows-widget-open", "notes.md", DOC);
      const recording = loadRecording("widget-answer.json");
      await replayRecording(page, recording);
      const widget = await summonWidget(page, editor);
      await sendWidgetPrompt(page, widget, promptTextOf(recording, 0));
      await expect(widget.locator("[data-blob-phase]")).toHaveAttribute("data-blob-phase", "done", {
        timeout: 30_000,
      });

      await widget.getByRole("button", { name: "Open chat" }).click();
      await expect(composer(page)).toBeVisible({ timeout: 15_000 });
      await expect(toolCards(page, "widget_respond").first()).toHaveAttribute("data-tool-status", "completed");
      await expect(entries(page, "user")).toContainText("Summarize this document");
    });

    test("Dismiss removes a done widget from the document", async ({ page }) => {
      await setupTestDatabase(page, "workflows-widget-dismiss");
      const editor = await openDocument(page, "/workspace/workflows-widget-dismiss", "notes.md", DOC);
      const recording = loadRecording("widget-answer.json");
      await replayRecording(page, recording);
      const widget = await summonWidget(page, editor);
      await sendWidgetPrompt(page, widget, promptTextOf(recording, 0));
      await expect(widget.locator("[data-blob-phase]")).toHaveAttribute("data-blob-phase", "done", {
        timeout: 30_000,
      });

      await widget.getByRole("button", { name: "Dismiss" }).click();
      await expect(widgets(page)).toHaveCount(0);
      await expect(editor).toContainText("para one");
      await expect(editor).toContainText("para two");
    });

    test("Escape while the widget's turn runs stops it", async ({ page }) => {
      // KNOWN FAILURE (found by this suite, 2026-09-19): with the caret in
      // the document (where it lands after sending), Escape reverts the
      // running widget to a literal "/" — the summoned-empty-draft revert
      // contract fires — and the turn keeps running; the in-flight Escape
      // hotkey (cancelAndRestore) never gets its say. Desired behavior is
      // asserted below; flip test.fail() off when the widget is fixed.
      test.fail();
      await setupTestDatabase(page, "workflows-widget-escape");
      const editor = await openDocument(page, "/workspace/workflows-widget-escape", "notes.md", DOC);
      const recording = loadRecording("streaming-slow.json");
      await replayRecording(page, recording, { speed: 1 });
      const widget = await summonWidget(page, editor);
      await sendWidgetPrompt(page, widget, promptTextOf(recording, 0));
      const face = widget.locator("[data-blob-phase]");
      await expect(face).toHaveAttribute("data-blob-phase", "running", { timeout: 15_000 });

      await page.keyboard.press("Escape");
      // The widget survives and its round is stopped.
      await expect(widgets(page)).toHaveCount(1);
      await expect
        .poll(async () => (await collectionStats(page)).settledTurns, {
          timeout: 15_000,
        })
        .toBe(1);
      await expect(face).not.toHaveAttribute("data-blob-phase", /running|queued|sending/);
      await expect(editor).not.toContainText("/");
    });

    test("a '/' over a selection captures it as a document reference in the prompt", async ({
      page,
    }) => {
      await setupTestDatabase(page, "workflows-widget-reference");
      const editor = await openDocument(page, "/workspace/workflows-widget-reference", "notes.md", DOC);
      await replayRecording(page, loadRecording("unknown-updates.json"));

      // Select the second paragraph's text with the keyboard (a real
      // TextSelection), then summon over it.
      const second = editor.locator("p", { hasText: "para two" });
      await second.click();
      await page.keyboard.press("End");
      await page.keyboard.press("Shift+Home");
      await page.waitForTimeout(200);
      await page.keyboard.type("/");
      const widget = widgets(page).first();
      await expect(widget).toBeVisible({ timeout: 10_000 });
      await expect(widget.getByRole("button", { name: "Remove reference" })).toBeVisible();
      // The selection stays in the document.
      await expect(editor).toContainText("para two");

      await sendWidgetPrompt(page, widget, "what does this mean");
      await expect(widget.locator("[data-blob-phase]")).toHaveAttribute("data-blob-phase", "done", {
        timeout: 30_000,
      });
      const { prompt } = await lastWirePrompt(page);
      const text = prompt.filter((b) => b.type === "text").map((b) => b.text).join("\n");
      expect(text).toMatch(/^>\s*\S/m); // the reference rides as a blockquote…
      expect(text).toContain("what does this mean"); // …ahead of the prompt
    });

    test("an agent write to the open document lands in the editor", async ({
      page,
    }) => {
      await setupTestDatabase(page, "workflows-widget-write");
      const editor = await openDocument(page, "/workspace/workflows-widget-write", "notes.md", DOC);
      const recording = loadRecording("file-write.json");
      await replayRecording(page, recording);
      const widget = await summonWidget(page, editor);
      await sendWidgetPrompt(page, widget, promptTextOf(recording, 0));
      await expect(editor).toContainText("AGENT_HEADING", { timeout: 30_000 });
    });
  });

  // ── Recording (the capture side of this workflow) ─────────────────────

  test.describe("recording", () => {
    test("the debug panel copies a replayable recording of what the harness sent", async ({
      page,
      context,
    }) => {
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
      const { recording } = await sessionWith(page, "export", "claude-todo.json");
      await sendAndSettle(page, promptTextOf(recording, 0));

      const tape = await exportRecording(page);
      expect(tape.format).toBe("notefig-agent-recording");
      expect(tape.version).toBe(1);
      expect(tape.harnessId).toBe(recording.harnessId);
      expect(tape.turns).toHaveLength(1);
      expect(tape.turns[0].prompt).toEqual([{ type: "text", text: promptTextOf(recording, 0) }]);
      expect(tape.turns[0].stopReason).toBe("end_turn");
      const kinds = tape.turns[0].events.map((e) =>
        e.kind === "update" ? `update:${(e.update as { sessionUpdate: string }).sessionUpdate}` : e.kind,
      );
      // Derived from the transcript: the ONE plan the turn kept (four
      // updates replaced it in place), each tool call once in its final
      // state, the thought and the reply as single chunks.
      expect(kinds.filter((k) => k === "update:plan")).toHaveLength(1);
      expect(kinds.filter((k) => k === "update:tool_call")).toHaveLength(3);
      expect(kinds.filter((k) => k === "update:agent_thought_chunk")).toHaveLength(1);
      expect(kinds[kinds.length - 1]).toBe("update:agent_message_chunk");
      const tools = tape.turns[0].events.filter(
        (e) => e.kind === "update" && (e.update as { sessionUpdate: string }).sessionUpdate === "tool_call",
      ) as Array<{ update: { status: string } }>;
      expect(tools.every((t) => t.update.status === "completed")).toBe(true);
    });
  });
});
