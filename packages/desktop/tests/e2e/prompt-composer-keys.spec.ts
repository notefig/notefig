/**
 * The in-document prompt composer's key surface (MET-80 / prompt-draft).
 *
 * The draft is document content, so its keys arrive through the aiPrompt
 * extension's addKeyboardShortcuts (key events in a contenteditable target
 * the editing host — the .ProseMirror root — so a DOM listener on the widget
 * can never see them; that routing bug shipped once). These tests cover the
 * whole contract end-to-end: summon via "/", Enter-send through the trust
 * gate, Escape/second-"/" revert, Backspace dismiss, and the three native
 * deletion strokes (soft-line, word, kill-line) that must stay clamped
 * inside the draft — unclamped, the browser's own editing mangles the
 * widget's DOM badly enough that the re-parse drops the node.
 *
 * Mod-Backspace note: Playwright's Desktop Chrome device reports a Windows
 * platform, so ProseMirror maps Mod to Ctrl there; the real app (WKWebView,
 * MacIntel) maps it to Meta. PW_WEBKIT=1 runs assert the Meta path.
 */
import { test, expect, type Page } from "@playwright/test";
import { openWorkspace, seedTestFiles, setupTestDatabase, waitForFileTree, openFileInTree } from "../setup/test-helpers";

const MOD_BACKSPACE = process.env.PW_WEBKIT ? "Meta+Backspace" : "Control+Backspace";

async function openDoc(page: Page, db: string, ws: string) {
  await setupTestDatabase(page, db);
  await openWorkspace(page, ws);
  await seedTestFiles(page, [{ path: `${ws}/notes.md`, content: "para one\n\npara two\n", type: "file" as const }]);
  await page.reload();
  await waitForFileTree(page, "notes.md");
  await openFileInTree(page, "notes.md");
  const editor = page.locator(".ProseMirror").locator("visible=true").first();
  await editor.waitFor();
  return editor;
}

function editorOf(page: Page) {
  return page.locator(".ProseMirror").locator("visible=true").first();
}

async function summon(page: Page, editor: ReturnType<Page["locator"]>) {
  await editor.locator("p").first().click({ position: { x: 1, y: 8 } });
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowUp");
  await page.waitForTimeout(300);
  await page.keyboard.type("/");
  const widget = page.locator('[data-type="ai-prompt"]').locator("visible=true").first();
  await expect(widget).toBeVisible({ timeout: 10000 });
  return widget;
}

test.describe("composer keys", () => {
  test.setTimeout(120000);

  test("backspace on empty summoned draft dismisses instantly", async ({ page }) => {
    const editor = await openDoc(page, "zzck-1", "/workspace/zzck-1");
    await summon(page, editor);
    const t0 = Date.now();
    await page.keyboard.press("Backspace");
    await expect(page.locator('[data-type="ai-prompt"]').locator("visible=true")).toHaveCount(0, { timeout: 5000 });
    console.log(`DISMISS ${Date.now() - t0}ms`);
  });

  test("mod+backspace with text clears the draft, keeps the widget", async ({ page }) => {
    const editor = await openDoc(page, "zzck-2", "/workspace/zzck-2");
    const widget = await summon(page, editor);
    await page.keyboard.type("some characters here");
    await page.waitForTimeout(100);
    await page.keyboard.press(MOD_BACKSPACE);
    await page.waitForTimeout(300);
    await expect(widget).toBeVisible();
    // draft emptied; a second mod+backspace on the now-empty summoned draft dismisses
    await page.keyboard.press(MOD_BACKSPACE);
    await expect(page.locator('[data-type="ai-prompt"]').locator("visible=true")).toHaveCount(0, { timeout: 5000 });
  });

  test("escape with text keeps widget and draft, exits to document", async ({ page }) => {
    const editor = await openDoc(page, "zzck-3", "/workspace/zzck-3");
    const widget = await summon(page, editor);
    await page.keyboard.type("keep me");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    await expect(widget).toBeVisible();
    await expect(widget).toContainText("keep me");
    // caret is back in the document: typing lands in the doc, not the draft
    await page.keyboard.type("X");
    await expect(widget).not.toContainText("keep meX");
  });

  test("escape on empty summoned draft reverts to a literal slash", async ({ page }) => {
    const editor = await openDoc(page, "zzck-4", "/workspace/zzck-4");
    await summon(page, editor);
    await page.keyboard.press("Escape");
    await expect(page.locator('[data-type="ai-prompt"]').locator("visible=true")).toHaveCount(0, { timeout: 5000 });
    await expect(editor).toContainText("/");
  });

  test("second slash in empty summoned draft reverts to a literal slash", async ({ page }) => {
    const editor = await openDoc(page, "zzck-5", "/workspace/zzck-5");
    await summon(page, editor);
    await page.keyboard.type("/");
    await expect(page.locator('[data-type="ai-prompt"]').locator("visible=true")).toHaveCount(0, { timeout: 5000 });
    await expect(editor).toContainText("/");
  });

  test("enter sends the draft (mock harness)", async ({ page }) => {
    const editor = await openDoc(page, "zzck-6", "/workspace/zzck-6");
    const widget = await summon(page, editor);
    await page.keyboard.type("hello agent");
    await page.keyboard.press("Enter");
    // sent face: the composing textarea row is replaced by the sent prompt
    await expect(widget).toContainText("hello agent", { timeout: 15000 });
    await expect(widget).not.toContainText("keep me");
    // first Enter lands on the trust gate; the second confirms and sends
    await page.keyboard.press("Enter");
    await expect(widget).not.toContainText("Press Enter again", { timeout: 15000 });
    await page.waitForTimeout(2000);
    const text = await widget.textContent();
    console.log("SENT face text: " + JSON.stringify(text?.slice(0, 200)));
  });

  test("alt+backspace word-deletes inside the draft, never past it", async ({ page }) => {
    const editor = await openDoc(page, "zzck-7", "/workspace/zzck-7");
    const widget = await summon(page, editor);
    await page.keyboard.type("two words");
    await page.keyboard.press("Alt+Backspace");
    await page.waitForTimeout(150);
    await expect(widget).toBeVisible();
    await expect(widget).toContainText("two");
    await expect(widget).not.toContainText("words");
    await page.keyboard.press("Alt+Backspace");
    await page.waitForTimeout(150);
    await expect(widget).toBeVisible();
    // empty summoned draft: word-delete dismisses like plain Backspace
    await page.keyboard.press("Alt+Backspace");
    await expect(page.locator('[data-type="ai-prompt"]').locator("visible=true")).toHaveCount(0, { timeout: 5000 });
    await expect(editor).toContainText("para one");
  });

  test("backspace dismisses a widget restored from a saved marker", async ({ page }) => {
    // Persisted markers parse with summoned: false — dismissal must not be
    // gated on the "/" contract (it once was, and the only way to delete a
    // restored widget was the native-editing mangle after some typing).
    const MARKER = '<!-- notefig:prompt id="blob_seededabcdef" task="task_seededabcdef" -->';
    await setupTestDatabase(page, "zzck-10");
    await openWorkspace(page, "/workspace/zzck-10");
    await seedTestFiles(page, [{
      path: "/workspace/zzck-10/notes.md",
      content: `para one\n\n${MARKER}\n\npara two\n`,
      type: "file" as const,
    }]);
    await page.reload();
    await waitForFileTree(page, "notes.md");
    await openFileInTree(page, "notes.md");
    const widget = page.locator('[data-type="ai-prompt"]').locator("visible=true").first();
    await expect(widget).toBeVisible({ timeout: 15000 });
    await widget.locator("[data-prompt-draft]").first().click();
    await page.waitForTimeout(200);
    await page.keyboard.press("Backspace");
    await expect(page.locator('[data-type="ai-prompt"]').locator("visible=true")).toHaveCount(0, { timeout: 5000 });
    await expect(editorOf(page)).toContainText("para one");
    await expect(editorOf(page)).toContainText("para two");
  });

  test("arrows cross the widget boundary in single steps", async ({ page }) => {
    const editor = await openDoc(page, "zzck-9", "/workspace/zzck-9");
    await summon(page, editor);
    await page.keyboard.type("draft text");
    await page.waitForTimeout(150);
    const sel = () => page.evaluate(() => {
      const ed = (document.querySelector(".ProseMirror") as unknown as { editor: { state: { selection: { $from: { parent: { type: { name: string } } } } } } }).editor;
      return ed.state.selection.$from.parent.type.name;
    });
    // one ArrowDown exits the draft into the next paragraph — no gap-cursor
    // stop on the widget's inner edge (allowGapCursor: false)
    await page.keyboard.press("ArrowDown");
    expect(await sel()).toBe("paragraph");
    // and one ArrowUp comes straight back into the draft
    await page.keyboard.press("ArrowUp");
    expect(await sel()).toBe("promptDraft");
  });

  test("ctrl+k kills inside the draft, never the paragraph after it", async ({ page }) => {
    const editor = await openDoc(page, "zzck-8", "/workspace/zzck-8");
    const widget = await summon(page, editor);
    await page.keyboard.type("tail text");
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press("Control+k");
      await page.waitForTimeout(100);
    }
    await expect(widget).toBeVisible();
    await expect(editor).toContainText("para one");
  });
});
