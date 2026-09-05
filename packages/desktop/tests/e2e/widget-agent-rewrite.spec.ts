/**
 * REPRO (MET-174): a sweeping agent rewrite of an open document deletes
 * prompt widgets from it.
 *
 * The mock agent (VITE_AGENT_MOCK) plays a one-turn scenario that rewrites
 * the whole file via fs/write_text_file — the same client path a real
 * adapter's write takes (writeWorkspaceTextFile → direct adoption into the
 * live editor). The document holds a bystander widget restored from a
 * persisted marker (MET-163) plus the widget that sent the prompt. Nothing
 * in the write or adoption path defends either marker, so both widgets are
 * expected to vanish. The assertions state the DESIRED behavior (widgets
 * survive), so this spec FAILS while the bug exists.
 */
import { test, expect, type Page } from "@playwright/test";
import {
  openFileInTree,
  openWorkspace,
  seedTestFiles,
  setupTestDatabase,
  waitForFileTree,
} from "../setup/test-helpers";

const WS = "/workspace/widget-rewrite";
const DOC = `${WS}/doc.md`;
const BYSTANDER_MARKER =
  '<!-- notefig:prompt id="blob_bystander0001" task="task_bystander0001" -->';

const REWRITTEN = [
  "# Rewritten",
  "",
  "REWRITTEN_SENTINEL — the agent replaced the whole document body.",
  "",
].join("\n");

function widgets(page: Page) {
  return page.locator('[data-type="ai-prompt"]').locator("visible=true");
}

test.describe("agent rewrite vs widgets", () => {
  test.setTimeout(120000);

  test("a whole-file agent write keeps the widgets in the document", async ({
    page,
  }) => {
    await setupTestDatabase(page, "widget-rewrite");
    await openWorkspace(page, WS);
    await seedTestFiles(page, [
      {
        path: DOC,
        content: [
          "para one",
          "",
          BYSTANDER_MARKER,
          "",
          "para two",
          "",
        ].join("\n"),
        type: "file" as const,
      },
    ]);
    await page.reload();
    await waitForFileTree(page, "doc.md");
    await openFileInTree(page, "doc.md");
    const editor = page.locator(".ProseMirror").locator("visible=true").first();
    await editor.waitFor();

    // The bystander widget restored from its persisted marker.
    await expect(widgets(page)).toHaveCount(1);

    // One turn: wait out the autosave that persists the sender's marker,
    // then rewrite the whole file — a scripted stand-in for "agent applies
    // sweeping changes".
    await page.evaluate(
      ({ path, content }) => {
        const mock = (window as any).__mockAgent;
        mock.register("sweepingRewrite", () => async (ctx: any) => {
          await ctx.sleep(2500);
          await ctx.request("fs/write_text_file", {
            sessionId: ctx.sessionId,
            path,
            content,
          });
          ctx.emit({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Rewrote the document." },
          });
          return { stopReason: "end_turn" };
        });
        mock.configure({ scenario: "sweepingRewrite" });
      },
      { path: DOC, content: REWRITTEN },
    );

    // Summon a second widget at the top and send the prompt through the
    // trust gate (first Enter arms it, second confirms).
    await editor.locator("p").first().click({ position: { x: 1, y: 8 } });
    await page.keyboard.press("Enter");
    await page.keyboard.press("ArrowUp");
    await page.waitForTimeout(300);
    await page.keyboard.type("/");
    await expect(widgets(page)).toHaveCount(2, { timeout: 10000 });
    await page.keyboard.type("rewrite this document");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");

    // While the turn runs, type into the bystander widget's draft — the
    // caret must still be there, at the end of the typed text, after the
    // rewrite is adopted (the caret-drop bug).
    const bystander = widgets(page).last();
    await bystander.locator("[data-prompt-draft]").click();
    await page.keyboard.type("mid turn note");

    // The agent's write landed and was adopted into the open editor.
    await expect(editor).toContainText("REWRITTEN_SENTINEL", {
      timeout: 30000,
    });

    // DESIRED: both the sender and the bystander widget survive the
    // rewrite. TODAY: the adoption replaces the doc wholesale and both are
    // gone — this is the bug.
    const editorText = await editor.textContent();
    console.log(
      "post-rewrite widget count:",
      await widgets(page).count(),
      "| editor text:",
      JSON.stringify(editorText?.slice(0, 200)),
    );
    await expect(widgets(page)).toHaveCount(2, { timeout: 5000 });

    // Caret preservation: still inside the bystander's draft, right after
    // the text typed mid-turn.
    await expect(bystander).toContainText("mid turn note");
    const caret = await page.evaluate(() => {
      const sel = document.getSelection();
      const anchor = sel?.anchorNode;
      const el =
        anchor instanceof Element ? anchor : anchor?.parentElement ?? null;
      return {
        inDraft: !!el?.closest("[data-prompt-draft]"),
        anchorText: anchor?.textContent ?? null,
        offset: sel?.anchorOffset ?? -1,
      };
    });
    expect(caret.inDraft).toBe(true);
    expect(caret.anchorText).toBe("mid turn note");
    expect(caret.offset).toBe("mid turn note".length);

    // Persistence: the repair wrote the re-asserted markers back to disk
    // inside the same tracked write, so a fresh parse of the file (reload)
    // must still show both widgets.
    await page.reload();
    await waitForFileTree(page, "doc.md");
    await openFileInTree(page, "doc.md");
    await expect(editor).toContainText("REWRITTEN_SENTINEL");
    await expect(widgets(page)).toHaveCount(2, { timeout: 10000 });
  });
});
