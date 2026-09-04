import { test, expect } from "@playwright/test";
import {
  openFileInTree,
  openWorkspace,
  seedTestFiles,
  setupTestDatabase,
  waitForFileTree,
} from "../setup/test-helpers";

const WORKSPACE_PATH = "/workspace/widget-selection";

/**
 * The prompt widget's CHROME is not prose — a document-wide selection must
 * not paint the card. The draft inside it IS prose, and paints with the rest
 * of the document.
 *
 * The bug: styles.css disables selection globally (`* { user-select: none }`)
 * and then re-enables it for the editor with `[contenteditable="true"] *`.
 * That descendant selector reaches EVERYTHING inside the ProseMirror root,
 * including the widget's node view, so dragging across the document (or ⌘A)
 * painted the whole card — status row, response, Reply box and background —
 * in selection blue.
 *
 * Asserted on computed `user-select` rather than a screenshot: the cascade is
 * the thing that broke, and reading it directly says which rule won instead
 * of just "these pixels differ".
 *
 * Two halves, and the second is why this can't just be `select-none` on the
 * wrapper:
 *  - the card chrome must be unselectable, but
 *  - the draft inside it is real document text that must still take a caret,
 *    and the agent's response opts back in via `.select-text` so it stays
 *    copyable.
 *
 * The draft is no longer a contenteditable of its own — it is content of the
 * document's own editor — so the opt-in is keyed to `[data-prompt-draft]`,
 * the row that holds it.
 */
/** A document with a mounted prompt widget. "New file" opens an empty
 *  scratchpad, and the empty-document keeper puts a widget in it with the
 *  caret already in its draft — the same node view, and the same cascade, as
 *  one summoned with "/" mid-prose. */
async function summonWidget(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "New file" }).click();
}

test.describe("prompt widget selection", () => {
  test.beforeEach(async ({ page }) => {
    await setupTestDatabase(page, "widget-selection");
    await openWorkspace(page, WORKSPACE_PATH);
    await seedTestFiles(page, [
      {
        // A persisted widget marker (MET-163) between paragraphs — the shape
        // the bug was reported against, and the only way to get a widget
        // into a document that also has prose to select.
        path: `${WORKSPACE_PATH}/doc.md`,
        content: [
          "Notefig is a monorepo that publishes text artifacts.",
          "",
          '<!-- notefig:prompt id="blob_1a2b" task="task_9f8e" -->',
          "",
          "More prose below the widget so the selection spans it.",
          "",
        ].join("\n"),
        type: "file" as const,
      },
    ]);
    await page.reload();
    await waitForFileTree(page, "doc.md");
  });

  test("document selection does not paint the widget chrome", async ({
    page,
  }) => {
    await summonWidget(page);

    const widget = page
      .locator('[data-type="ai-prompt"]')
      .locator("visible=true")
      .first();
    await expect(widget).toBeVisible();

    const selection = await page.evaluate(() => {
      const widgetEl = document.querySelector<HTMLElement>(
        '.ProseMirror [data-type="ai-prompt"]',
      );
      if (!widgetEl) return null;
      const read = (el: Element | null) =>
        el ? getComputedStyle(el).userSelect : null;

      // The draft is document content; the caret has to land in it.
      const composer = widgetEl.querySelector("[data-prompt-draft]");

      return {
        chrome: read(widgetEl),
        // A plain chrome descendant — the status/reply row wrappers.
        chromeChild: read(widgetEl.querySelector("div")),
        composer: read(composer),
        composerChild: read(composer?.querySelector("*") ?? null),
      };
    });

    expect(selection).not.toBeNull();
    // The card and its chrome: never selectable.
    expect(selection!.chrome).toBe("none");
    expect(selection!.chromeChild).toBe("none");
    // The draft and its contents: still fully editable/selectable.
    expect(selection!.composer).toBe("text");
    if (selection!.composerChild) {
      expect(selection!.composerChild).toBe("text");
    }
  });

  test("a document-wide selection paints the draft like the prose around it", async ({
    page,
  }) => {
    // The draft is document text, so ⌘A includes it — visibly. (An earlier
    // iteration suppressed the paint unless the selection stayed inside the
    // draft, which read as "select all skipped my prompt". Undifferentiated
    // is the contract now.)
    //
    // Asserted on pixels because that is literally the property: the draft
    // must light up with the rest of the document. Chromium's
    // getComputedStyle does not resolve author ::selection rules, so reading
    // the cascade here is not an option (an earlier version of this test
    // tried, and reported the browser default no matter what was applied).
    await openFileInTree(page, "doc.md");
    const widget = page
      .locator('[data-type="ai-prompt"]')
      .locator("visible=true")
      .first();
    await expect(widget).toBeVisible();

    // The paint needs text to land on, and the select-all starts from
    // inside the composer — the reported scenario.
    const composer = widget.locator("[data-prompt-draft]").first();
    await composer.click();
    await page.keyboard.type("words in the draft");
    await expect(composer).toContainText("words in the draft");

    // A blinking caret would make any two shots differ; take it out of the
    // comparison so the only possible delta is the selection paint.
    await page.addStyleTag({ content: "* { caret-color: transparent; }" });
    // Settle before the baseline: the widget mounts its own chrome, and a
    // shot taken mid-mount would differ for reasons that have nothing to do
    // with selection.
    await page.waitForTimeout(500);
    const unselected = await widget.screenshot();

    await page.keyboard.press("ControlOrMeta+a");
    await page.waitForTimeout(500);
    const selected = await widget.screenshot();

    // The whole document must actually be selected — prose and draft both —
    // or the shot comparison proves nothing.
    const selectedText = await page.evaluate(
      () => window.getSelection()?.toString() ?? "",
    );
    expect(selectedText).toContain("monorepo");
    expect(selectedText).toContain("words in the draft");

    expect(selected.equals(unselected)).toBe(false);
  });

  test("the draft still accepts typing", async ({ page }) => {
    await summonWidget(page);

    const widget = page
      .locator('[data-type="ai-prompt"]')
      .locator("visible=true")
      .first();
    await expect(widget).toBeVisible();

    // Guards the fix's real risk: making the card unselectable must not
    // reach the draft inside it. Chromium refuses to place a caret in
    // user-select:none text, so a regression here shows up as a composer
    // that silently swallows keystrokes.
    const composer = widget.locator("[data-prompt-draft]").first();
    await composer.click();
    await page.keyboard.type("still typable");
    await expect(composer).toContainText("still typable");
  });
});
