import { test, expect } from "@playwright/test";
import {
  openWorkspace,
  seedTestFiles,
  setupTestDatabase,
  waitForFileTree,
} from "../setup/test-helpers";

const WORKSPACE_PATH = "/workspace/widget-selection";

/**
 * The prompt widget is chrome, not prose — a document-wide selection must not
 * paint it.
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
 *  - the composer inside it is a real contenteditable that must still take a
 *    caret, and the agent's response opts back in via `.select-text` so it
 *    stays copyable.
 */
/** A document with a mounted prompt widget. "New file" opens an empty
 *  scratchpad, and the empty-document keeper puts a widget in it — the same
 *  node view, and the same cascade, as one summoned with "/" mid-prose. */
async function summonWidget(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "New file" }).click();
}

test.describe("prompt widget selection", () => {
  test.beforeEach(async ({ page }) => {
    await setupTestDatabase(page, "widget-selection");
    await openWorkspace(page, WORKSPACE_PATH);
    await seedTestFiles(page, [
      {
        path: `${WORKSPACE_PATH}/doc.md`,
        content: "Notefig is a monorepo that publishes text artifacts.\n",
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

      // The composer is a nested ProseMirror; the caret has to land in it.
      const composer = widgetEl.querySelector('[contenteditable="true"]');

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
    // The composer and its contents: still fully editable/selectable.
    expect(selection!.composer).toBe("text");
    if (selection!.composerChild) {
      expect(selection!.composerChild).toBe("text");
    }
  });

  test("a .select-text region inside the widget stays selectable", async ({
    page,
  }) => {
    await summonWidget(page);
    const widget = page
      .locator('[data-type="ai-prompt"]')
      .locator("visible=true")
      .first();
    await expect(widget).toBeVisible();

    // The done face marks the agent's response `.select-text` so it can be
    // copied out. That opt-in and the deny above have EQUAL specificity, so
    // it only wins on source order — a fragile thing to rely on silently,
    // and it cannot be observed here without a finished turn. Probing the
    // cascade with a stand-in element is the cheap way to pin it.
    const selectable = await page.evaluate(() => {
      const widgetEl = document.querySelector<HTMLElement>(
        '.ProseMirror [data-type="ai-prompt"]',
      );
      if (!widgetEl) return null;
      const probe = document.createElement("div");
      probe.className = "select-text";
      const child = document.createElement("p");
      probe.appendChild(child);
      widgetEl.appendChild(probe);
      const result = {
        container: getComputedStyle(probe).userSelect,
        child: getComputedStyle(child).userSelect,
      };
      probe.remove();
      return result;
    });

    expect(selectable).toEqual({ container: "text", child: "text" });
  });

  test("the composer still accepts typing", async ({ page }) => {
    await summonWidget(page);

    const widget = page
      .locator('[data-type="ai-prompt"]')
      .locator("visible=true")
      .first();
    await expect(widget).toBeVisible();

    // Guards the fix's real risk: making the card unselectable must not
    // reach the contenteditable inside it. Chromium refuses to place a caret
    // in user-select:none text, so a regression here shows up as a composer
    // that silently swallows keystrokes.
    const composer = widget.locator('[contenteditable="true"]').first();
    await composer.click();
    await page.keyboard.type("still typable");
    await expect(composer).toContainText("still typable");
  });
});
