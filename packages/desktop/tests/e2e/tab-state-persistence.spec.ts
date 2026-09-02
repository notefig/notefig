/**
 * Tab state persistence — what a tab must remember while it is not the
 * selected tab in its window.
 *
 * The dock mounts only the selected tab, so everything a tab type does not
 * explicitly persist outside React dies on every tab switch. These are the
 * user-visible symptoms of that.
 */
import { expect, test, type Page } from "@playwright/test";
import {
  openFileInNewTab,
  openFileInTree,
  openWorkspace,
  seedTestFiles,
  setupTestDatabase,
  waitForFileTree,
} from "../setup/test-helpers";

const WORKSPACE_PATH = "/workspace/tab-state";

const longDocument = Array.from(
  { length: 200 },
  (_, index) => `Line ${index + 1} of the long document.`,
).join("\n\n");

const fixtureFiles = [
  {
    path: `${WORKSPACE_PATH}/long.md`,
    content: longDocument,
    type: "file" as const,
  },
  {
    // A document carrying a persisted prompt widget (MET-163), so the draft
    // test has one to type in without going through the "/" summon.
    path: `${WORKSPACE_PATH}/widget.md`,
    content: [
      "Prose above the widget.",
      "",
      '<!-- notefig:prompt id="blob_tabstate" task="task_tabstate" -->',
      "",
      "Prose below the widget.",
      "",
    ].join("\n"),
    type: "file" as const,
  },
  {
    path: `${WORKSPACE_PATH}/other.md`,
    content: "a short second document",
    type: "file" as const,
  },
];

async function clickTab(page: Page, name: string) {
  const tabBar = page.locator('[data-testid="tab-bar"]');
  await tabBar.locator(`.cursor-pointer:has-text("${name}")`).first().click();
  await page.waitForTimeout(300);
}

/** Where the caret sits, when it sits in a prompt widget's draft. */
async function caretInDraft(page: Page) {
  return page.evaluate(() => {
    const node = window.getSelection()?.anchorNode ?? null;
    const element =
      node instanceof Element ? node : (node?.parentElement ?? null);
    const draft = element?.closest("[data-prompt-draft]");
    return {
      inDraft: Boolean(draft),
      offset: window.getSelection()?.anchorOffset ?? -1,
      text: draft?.textContent ?? "",
    };
  });
}

/** scrollTop of the visible editor's scroll container. */
async function visibleEditorScrollTop(page: Page): Promise<number> {
  return page.evaluate(() => {
    const wrappers = Array.from(
      document.querySelectorAll<HTMLElement>(".tiptap-editor-wrapper"),
    );
    const visible = wrappers.find((el) => el.offsetParent !== null);
    return visible ? visible.scrollTop : -1;
  });
}

test.describe("tab state persistence", () => {
  test.beforeEach(async ({ page }, testInfo) => {
    await setupTestDatabase(page, testInfo.title);
    await openWorkspace(page, WORKSPACE_PATH);
    await seedTestFiles(page, fixtureFiles);
    await page.reload();
    await waitForFileTree(page);
  });

  test("scroll position survives switching away and back", async ({ page }) => {
    await openFileInTree(page, "long.md");
    await openFileInNewTab(page, "other.md");

    await clickTab(page, "long.md");

    await page.evaluate(() => {
      const wrappers = Array.from(
        document.querySelectorAll<HTMLElement>(".tiptap-editor-wrapper"),
      );
      const visible = wrappers.find((el) => el.offsetParent !== null);
      visible?.scrollTo({ top: 800 });
    });
    await page.waitForTimeout(200);
    const before = await visibleEditorScrollTop(page);
    expect(before).toBeGreaterThan(400);

    await clickTab(page, "other.md");
    await clickTab(page, "long.md");

    // Restored to the top of the block that was at the top edge, so the
    // offset lands within a line height of where it was — not at the caret,
    // which is still up at the start of the document.
    expect(await visibleEditorScrollTop(page)).toBeGreaterThan(before - 40);
  });

  test("caret position survives switching away and back", async ({ page }) => {
    await openFileInTree(page, "long.md");
    await openFileInNewTab(page, "other.md");

    await clickTab(page, "long.md");

    // Click into a paragraph well down the document, then type so the caret
    // is somewhere unambiguous.
    const paragraph = page
      .locator('[role="textbox"]:visible p:has-text("Line 12 of")')
      .first();
    await paragraph.click();
    await page.keyboard.type("!");
    await page.waitForTimeout(200);
    const before = await page.evaluate(
      () => window.getSelection()?.anchorNode?.textContent ?? "",
    );
    expect(before).toContain("Line 12 of");

    await clickTab(page, "other.md");
    await clickTab(page, "long.md");
    await page.waitForTimeout(300);

    const after = await page.evaluate(
      () => window.getSelection()?.anchorNode?.textContent ?? "",
    );
    expect(after).toBe(before);
  });

  /**
   * The prompt widget's composer used to be a second Tiptap editor, invisible
   * to everything above: coming back to a tab put the caret in the DOCUMENT,
   * at the position from before the widget was summoned, and painted the row
   * above the widget as selected (the "/" summon leaves a NodeSelection on
   * the widget, which was saved as a bare range and restored as text).
   *
   * The draft is document content now, so it is the same saved selection as
   * the test above — this asserts that it really is the same mechanism, not
   * a widget-shaped copy of it.
   */
  test("a caret inside a prompt widget survives the same way", async ({
    page,
  }) => {
    await openFileInTree(page, "widget.md");
    await openFileInNewTab(page, "other.md");
    await clickTab(page, "widget.md");

    const draft = page
      .locator('[data-type="ai-prompt"] [data-prompt-draft]')
      .locator("visible=true")
      .first();
    await draft.click();
    await page.keyboard.type("rewrite the opening paragraph");
    // Back into the middle of the draft: landing at the end would pass even
    // if the caret were merely re-placed rather than restored.
    for (let i = 0; i < 9; i++) await page.keyboard.press("ArrowLeft");
    const before = await caretInDraft(page);
    expect(before.inDraft).toBe(true);

    await clickTab(page, "other.md");
    await clickTab(page, "widget.md");

    await expect
      .poll(async () => (await caretInDraft(page)).inDraft, { timeout: 5000 })
      .toBe(true);
    const after = await caretInDraft(page);
    expect(after.text).toContain("rewrite the opening paragraph");
    expect(after.offset).toBe(before.offset);
    // …and nothing in the document itself is selected — the artefact this
    // replaced was a highlighted row above the widget.
    expect(
      await page.evaluate(() => window.getSelection()?.toString() ?? ""),
    ).toBe("");
  });
});
