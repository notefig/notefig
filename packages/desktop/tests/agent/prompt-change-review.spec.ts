/**
 * Reviewing what a prompt widget's round changed: the agent's edits to the
 * open document are highlighted in the widget's colour until they are
 * overwritten or the widget moves on.
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

function highlights(page: Page) {
  return page
    .locator(".ProseMirror [data-prompt-change]")
    .locator("visible=true");
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

  test("an ACP write is highlighted until the widget is dismissed", async ({
    page,
  }) => {
    const workspacePath = "/workspace/change-review-acp";
    await setupTestDatabase(page, "change-review-acp");
    const editor = await openDocument(page, workspacePath, "notes.md", DOC);
    await scriptEdit(
      page,
      "acp",
      `${workspacePath}/notes.md`,
      `# AGENT_HEADING\n\n${DOC}`,
    );
    const widget = await summonWidget(page, editor);
    await sendWidgetPrompt(page, widget, "add a heading");
    await expect(editor).toContainText("AGENT_HEADING", { timeout: 30_000 });

    // Exactly the new heading — not the untouched paragraphs, not the
    // widget the rewrite had to re-insert.
    await expect(highlights(page)).toHaveText(["AGENT_HEADING"]);
    // The done face ties its file chip to the highlight.
    await expect(widget.locator("button[data-changes]")).toHaveText("notes.md");

    await widget.getByRole("button", { name: "Dismiss" }).click();
    await expect(highlights(page)).toHaveCount(0);
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
    await expect(highlights(page)).toHaveText(["NATIVE_LINE from the harness"]);

    // The user rewrites the line: the round's text is gone, and so is its
    // highlight.
    await editor
      .getByText("NATIVE_LINE from the harness")
      .click({ clickCount: 3 });
    await page.keyboard.type("my own words");
    await expect(editor).toContainText("my own words");
    await expect(highlights(page)).toHaveCount(0);
  });
});
