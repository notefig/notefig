/**
 * Reviewing what a prompt widget's round changed: every block the agent's
 * edits touched carries a passive gutter bar in the widget's colour, and
 * the widget steps through them (scrolling each into view) or clears them.
 * Marks also go when the text is overwritten or the widget moves on.
 *
 * Both ways an agent write reaches the editor are covered — an ACP
 * `fs/write_text_file` (adopted while the tool call runs) and a harness
 * writing to disk itself, the way Claude Code does (adopted when the
 * watcher delivers it, after the tool call has settled). The tool calls
 * carry `locations` the way claude-agent-acp's Write/Edit do.
 *
 *   npx playwright test --project=agent tests/agent/prompt-change-review.spec.ts
 */
import { test, expect, type Page } from "@playwright/test";
import { setupTestDatabase } from "../setup/test-helpers";
import { openDocument, sendWidgetPrompt, summonWidget } from "./agent-helpers";

/* eslint-disable @typescript-eslint/no-explicit-any */

const DOC = "para one\n\npara two\n";

/** The gutter marks, visible ones only (every tab's editor is mounted). */
function marks(page: Page) {
  return page.locator("[data-prompt-change-mark]").locator("visible=true");
}

/** The text of the block beside each gutter mark, top to bottom. */
function markedBlocks(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const editor = [...document.querySelectorAll<HTMLElement>(".ProseMirror")]
      .find((el) => el.offsetParent !== null)!;
    const blocks = [...editor.querySelectorAll<HTMLElement>("p, h1, h2, h3, li > p")];
    return [...document.querySelectorAll<HTMLElement>("[data-prompt-change-mark]")]
      .filter((mark) => mark.offsetParent !== null)
      .map((mark) => {
        const box = mark.getBoundingClientRect();
        const middle = box.top + Math.max(box.height, 1) / 2;
        const block = blocks.find((el) => {
          const r = el.getBoundingClientRect();
          return middle >= r.top && middle <= r.bottom;
        });
        return block?.textContent ?? "?";
      });
  });
}

/** One turn: an Edit on `path` that writes `content` — through the client
 *  (`acp`) or straight to disk (`native`) — then settles. */
async function scriptEdit(
  page: Page,
  write: "acp" | "native",
  path: string,
  content: string,
) {
  await page.evaluate(
    ({ write, path, content }) => {
      const mock = (window as any).__mockAgent;
      mock.register("scriptedEdit", () => async (ctx: any) => {
        const toolCallId = "tc_edit";
        // Think first, like a real agent: an edit racing the send's own
        // marker autosave is a different story (last writer wins).
        await ctx.sleep(1500);
        ctx.emit({
          sessionUpdate: "tool_call",
          toolCallId,
          title: "Edit notes.md",
          kind: "edit",
          status: "in_progress",
          locations: [{ path }],
        });
        if (write === "acp") {
          await ctx.request("fs/write_text_file", {
            sessionId: ctx.sessionId,
            path,
            content,
          });
          ctx.emit({ sessionUpdate: "tool_call_update", toolCallId, status: "completed" });
        } else {
          // The Claude Code order: the file changes on disk, the tool
          // reports done, and only then does the watcher tell the app.
          await ctx.writeNatively(path, content);
          ctx.emit({ sessionUpdate: "tool_call_update", toolCallId, status: "completed" });
          await ctx.sleep(300);
          await ctx.notifyWatcher(path);
        }
        ctx.emit({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Edited." },
        });
        return { stopReason: "end_turn" };
      });
      mock.configure({ scenario: "scriptedEdit" });
    },
    { write, path, content },
  );
}

test.describe("prompt change review", () => {
  test.setTimeout(90_000);

  test("an ACP write marks the blocks it changed; the widget steps through and clears them", async ({
    page,
  }) => {
    const workspacePath = "/workspace/change-review-acp";
    await setupTestDatabase(page, "change-review-acp");
    const editor = await openDocument(page, workspacePath, "notes.md", DOC);
    await scriptEdit(
      page,
      "acp",
      `${workspacePath}/notes.md`,
      "# AGENT_HEADING\n\npara one\n\npara two, revised\n",
    );
    const widget = await summonWidget(page, editor);
    await sendWidgetPrompt(page, widget, "add a heading");
    await expect(editor).toContainText("AGENT_HEADING", { timeout: 30_000 });

    // Exactly the blocks it touched — not the untouched paragraph, not the
    // widget the rewrite had to re-insert.
    await expect
      .poll(() => markedBlocks(page))
      .toEqual(["AGENT_HEADING", "para two, revised"]);
    // The done face ties its file chip to the marks.
    await expect(widget.locator("button[data-changes]")).toHaveText("notes.md");

    // The widget steps through them in document order, pulsing each bar.
    const navigator = widget.locator("[data-change-navigator]");
    await expect(navigator).toContainText("2 changed");
    await navigator.getByRole("button", { name: "Next change" }).click();
    await expect(navigator).toContainText("1 of 2");
    await expect(marks(page).first()).toHaveAttribute("data-pulse", "");
    await navigator.getByRole("button", { name: "Next change" }).click();
    await expect(navigator).toContainText("2 of 2");
    await navigator.getByRole("button", { name: "Previous change" }).click();
    await expect(navigator).toContainText("1 of 2");

    // Clear drops every mark and leaves the text alone.
    await navigator.getByRole("button", { name: "Clear" }).click();
    await expect(marks(page)).toHaveCount(0);
    await expect(navigator).toHaveCount(0);
    await expect(editor).toContainText("para two, revised");
  });

  test("a native write adopted after the tool settles is credited; overwriting it clears it", async ({
    page,
  }) => {
    const workspacePath = "/workspace/change-review-native";
    await setupTestDatabase(page, "change-review-native");
    const editor = await openDocument(page, workspacePath, "notes.md", DOC);
    await scriptEdit(
      page,
      "native",
      `${workspacePath}/notes.md`,
      `${DOC}\nNATIVE_LINE from the harness\n`,
    );
    const widget = await summonWidget(page, editor);
    await sendWidgetPrompt(page, widget, "add a closing line");
    await expect(editor).toContainText("NATIVE_LINE", { timeout: 30_000 });
    await expect
      .poll(() => markedBlocks(page))
      .toEqual(["NATIVE_LINE from the harness"]);

    // The user rewrites the line: the round's text is gone, and so is its
    // mark.
    await editor
      .getByText("NATIVE_LINE from the harness")
      .click({ clickCount: 3 });
    await page.keyboard.type("my own words");
    await expect(editor).toContainText("my own words");
    await expect(marks(page)).toHaveCount(0);
  });
});
