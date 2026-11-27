/**
 * When the agent fails: a turn the API failed, an agent process that
 * exited, and what Retry does — against the mock harness's misbehaviours
 * (`/error`, `/flaky N`, `/crash`; see src/modules/agents/mock-harness.ts),
 * through the real ACP client, agent service, chat tab and prompt widget.
 *
 * Runs in the `agent` Playwright project (VITE_AGENT_MOCK=1).
 */
import { test, expect, type Page } from "@playwright/test";
import { setupTestDatabase } from "../setup/test-helpers";
import {
  collectionStats,
  entries,
  openDocument,
  sendAndSettle,
  sendWidgetPrompt,
  startMockSession,
  summonWidget,
} from "./agent-helpers";

/* eslint-disable @typescript-eslint/no-explicit-any */

const DOC = "# Notes\n\nA paragraph to work on.\n";

/** Every prompt the mock agents were sent, and to which session. */
function sent(page: Page): Promise<{ sessionId: string; text: string }[]> {
  return page.evaluate(() => (window as any).__mockAgent.prompts());
}

/** The virtual row index of a transcript row. */
async function rowIndex(page: Page, selector: string): Promise<number> {
  const index = await page
    .locator(selector)
    .last()
    .locator("xpath=ancestor-or-self::*[@data-index][1]")
    .getAttribute("data-index");
  return Number(index);
}

test.describe("agent errors", () => {
  test.setTimeout(90_000);

  test.describe("chat", () => {
    test("a failed turn's error stays with it: the turns after it read below it", async ({
      page,
    }) => {
      await setupTestDatabase(page, "errors-chat-inline");
      await startMockSession(page, "/workspace/errors-chat-inline");
      await sendAndSettle(page, "/error");
      await expect(entries(page, "turn_error")).toContainText("Overloaded (mock)");

      await sendAndSettle(page, "and now?");
      await expect(entries(page, "assistant").last()).toContainText("and now?");
      const error = await rowIndex(page, '[data-entry-type="turn_error"]');
      const nextPrompt = await rowIndex(page, '[data-entry-type="user"]');
      expect(error).toBeLessThan(nextPrompt);
    });

    test("a session whose agent exited comes back for the next prompt, on the same session", async ({
      page,
    }) => {
      await setupTestDatabase(page, "errors-chat-crash");
      await startMockSession(page, "/workspace/errors-chat-crash");
      await sendAndSettle(page, "/crash");
      await expect(entries(page, "turn_error")).toContainText("agent process exited");

      await sendAndSettle(page, "still there?");
      await expect(entries(page, "assistant").last()).toContainText("still there?");
      const prompts = await sent(page);
      expect(prompts.map((p) => p.text)).toEqual(["/crash", "still there?"]);
      expect(new Set(prompts.map((p) => p.sessionId)).size).toBe(1);
    });
  });

  test.describe("prompt widget", () => {
    for (const { name, command } of [
      { name: "an API error", command: "/flaky 1" },
      { name: "an agent that exited", command: "/crash" },
    ]) {
      test(`Retry after ${name} sends the same prompt again, on the same session`, async ({
        page,
      }) => {
        const slug = name.replace(/\W+/g, "-");
        await setupTestDatabase(page, `errors-widget-${slug}`);
        const editor = await openDocument(page, `/workspace/errors-widget-${slug}`, "notes.md", DOC);
        const widget = await summonWidget(page, editor);
        // After the words: a widget's draft can't start with "/".
        await sendWidgetPrompt(page, widget, `tidy this up ${command}`);
        const face = widget.locator("[data-blob-phase]");
        await expect(face).toHaveAttribute("data-blob-phase", "error", { timeout: 15_000 });

        await widget.getByRole("button", { name: "Retry" }).click();
        await expect(face).toHaveAttribute("data-blob-phase", "done", { timeout: 15_000 });

        const prompts = await sent(page);
        expect(prompts).toHaveLength(2);
        expect(prompts[1].text).toBe(prompts[0].text);
        expect(prompts[1].sessionId).toBe(prompts[0].sessionId);
        // No second session was started for it.
        expect((await collectionStats(page)).tasks).toBe(1);
      });
    }
  });
});
