/**
 * Typing on a selected prompt widget (MET-248): every key lands in one
 * place. A widget the keyboard selected takes the keys in its field; a
 * select-all over it replaces it, as Delete would.
 */
import { test, expect, type Page } from "@playwright/test";
import {
  openFileInTree,
  openWorkspace,
  seedTestFiles,
  setupTestDatabase,
  waitForFileTree,
} from "../setup/test-helpers";

const WS = "/workspace/widget-typing";

/** The document as blocks: a widget as `[widget:<draft>]`. */
function blocks(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const view = document.querySelector(".ProseMirror") as unknown as {
      editor: { state: { doc: { forEach(fn: (node: any) => void): void } } };
    };
    const out: string[] = [];
    view.editor.state.doc.forEach((node) =>
      out.push(
        node.type.name === "aiPrompt"
          ? `[widget:${node.textContent}]`
          : node.textContent,
      ),
    );
    return out;
  });
}

/** A document with a settled widget opening it, above two paragraphs. */
async function settledWidget(page: Page, name: string) {
  await setupTestDatabase(page, name);
  await openWorkspace(page, WS);
  await seedTestFiles(page, [
    {
      path: `${WS}/${name}.md`,
      content: ["Para above.", "", "Para below.", ""].join("\n"),
      type: "file" as const,
    },
  ]);
  await page.reload();
  await waitForFileTree(page, `${name}.md`);
  await openFileInTree(page, `${name}.md`);
  const editor = page.locator(".ProseMirror").locator("visible=true").first();
  await expect(editor).toContainText("Para below.");
  await page.evaluate(() => {
    const mock = (window as any).__mockAgent;
    mock.register("answer", () => async (ctx: any) => {
      ctx.emit({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Done." },
      });
      return { stopReason: "end_turn" };
    });
    mock.configure({ scenario: "answer" });
  });
  await editor.locator("p").first().click({ position: { x: 1, y: 8 } });
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowUp");
  await page.waitForTimeout(300);
  await page.keyboard.type("/");
  await page.keyboard.type("shorten this");
  // Send through the trust gate (first Enter arms it, second confirms).
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await expect(page.locator('[data-blob-phase="done"]').first()).toBeVisible({
    timeout: 30000,
  });
  // The card grows as it settles; click once the paragraph holds still,
  // and until the caret is in it.
  await expect(async () => {
    await editor.locator("p", { hasText: "Para above." }).click();
    expect(await caretBlockText(page)).toBe("Para above.");
  }).toPass({ timeout: 10000 });
  return editor;
}

/** The text of the block the caret is in. */
function caretBlockText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const view = document.querySelector(".ProseMirror") as unknown as {
      editor: { state: { selection: { $from: { parent: { textContent: string } } } } };
    };
    return view.editor.state.selection.$from.parent.textContent;
  });
}

test.describe("typing on a selected prompt widget", () => {
  test.setTimeout(90000);

  test("a keyboard-selected widget takes every key in its field", async ({
    page,
  }) => {
    await settledWidget(page, "typing-keyboard");
    await page.keyboard.press("Home");
    await page.keyboard.press("Backspace");
    await expect(page.locator(".node-aiPrompt[data-widget-selected]")).toHaveCount(1);
    await page.keyboard.type("xyz");
    await expect
      .poll(() => blocks(page))
      .toEqual(["[widget:xyz]", "Para above.", "Para below."]);
  });

  test("typing over a select-all replaces the widget with the rest", async ({
    page,
  }) => {
    await settledWidget(page, "typing-select-all");
    await page.keyboard.press("ControlOrMeta+a");
    await expect(page.locator(".node-aiPrompt[data-widget-selected]")).toHaveCount(1);
    await page.keyboard.type("xyz");
    await expect.poll(() => blocks(page)).toEqual(["xyz"]);
  });
});
