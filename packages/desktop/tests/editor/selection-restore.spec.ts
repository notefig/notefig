/**
 * The caret and selection across React commits, with the react-dom patch
 * (patches/react-dom+*.patch) that stops React measuring a ProseMirror
 * root's selection by walking its whole DOM before every commit.
 *
 * React only uses what it saved when a commit moves focus off the editor
 * (a re-parented editor): it then puts the selection back and refocuses.
 * The harness's `swapColumns` makes React move the editor's column, which
 * drops DOM focus mid-commit, so these tests drive exactly that restore and
 * check the selection at the moment React refocuses the editor. (Something
 * in the app blurs the editor again after that, with or without the patch.)
 */
import { test, expect, type Page } from "@playwright/test";

const BASE = "/harness-ws";
const DOC = `${BASE}/doc.md`;

const paragraphs = Array.from(
  { length: 60 },
  (_, i) => `Paragraph ${i + 1} alpha bravo charlie delta.`,
);

async function openHarness(page: Page) {
  await page.addInitScript(
    ({ BASE, DOC, content }) => {
      const w = window as unknown as Record<string, unknown>;
      w.__NOTEFIG_FORCE_INDEXEDDB__ = true;
      w.__EDITOR_HARNESS__ = { basePath: BASE, filePath: DOC, content };
    },
    { BASE, DOC, content: `${paragraphs.join("\n\n")}\n` },
  );
  await page.goto("/__harness/editor");
  // The first load can wait on Vite optimizing dependencies.
  await expect(page.locator(".ProseMirror")).toBeVisible({ timeout: 25_000 });
}

interface Snapshot {
  focused: boolean;
  domText: string;
  anchorText: string | null;
  anchorOffset: number;
  focusOffset: number;
  pmFrom: number;
  pmTo: number;
}

/** DOM focus and selection, plus ProseMirror's own selection. */
const snapshot = (page: Page) =>
  page.evaluate((DOC): Snapshot => {
    const w = window as unknown as {
      __notefigCore: {
        editors: {
          markdownEditor(path: string): {
            state: { selection: { from: number; to: number } };
          } | null;
        };
      };
    };
    const root = document.querySelector(".ProseMirror");
    const sel = window.getSelection()!;
    const pm = w.__notefigCore.editors.markdownEditor(DOC)!.state.selection;
    return {
      focused: document.activeElement === root,
      domText: sel.toString(),
      anchorText: sel.anchorNode?.textContent ?? null,
      anchorOffset: sel.anchorOffset,
      focusOffset: sel.focusOffset,
      pmFrom: pm.from,
      pmTo: pm.to,
    };
  }, DOC);

const getMarkdown = (page: Page) =>
  page.evaluate(() =>
    (
      window as unknown as { __HARNESS__: { getMarkdown(): string | null } }
    ).__HARNESS__.getMarkdown(),
  );

/** Put the caret after "Paragraph 30 alpha", then extend `extend` chars. */
async function placeCaret(page: Page, extend: number) {
  const target = page.locator(".ProseMirror p", {
    hasText: /^Paragraph 30 alpha/,
  });
  await target.click();
  await page.keyboard.press("Home");
  for (let i = 0; i < "Paragraph 30 alpha".length; i++) {
    await page.keyboard.press("ArrowRight");
  }
  for (let i = 0; i < extend; i++) await page.keyboard.press("Shift+ArrowRight");
  // ProseMirror reads the browser's selection on selectionchange, a beat
  // after the keys: wait until both agree on the range.
  await expect
    .poll(async () => {
      const now = await snapshot(page);
      await page.waitForTimeout(50);
      const later = await snapshot(page);
      return (
        JSON.stringify(now) === JSON.stringify(later) &&
        now.pmTo - now.pmFrom === extend &&
        now.domText.length === extend
      );
    })
    .toBe(true);
}

/**
 * Move the editor twice (the second flip is the one that moves its column)
 * and return the selection as it stood when React refocused the editor —
 * right after React put the saved selection back. What happens to focus
 * after that is the app's, not React's.
 */
async function moveEditor(page: Page): Promise<Snapshot | null> {
  return page.evaluate(async (DOC) => {
    const root = document.querySelector<HTMLElement>(".ProseMirror")!;
    let atRefocus: Snapshot | null = null;
    const focus = root.focus.bind(root);
    root.focus = (options?: FocusOptions) => {
      const sel = window.getSelection()!;
      const w = window as unknown as {
        __notefigCore: {
          editors: {
            markdownEditor(path: string): {
              state: { selection: { from: number; to: number } };
            } | null;
          };
        };
      };
      const pm = w.__notefigCore.editors.markdownEditor(DOC)!.state.selection;
      atRefocus ??= {
        focused: document.activeElement === root,
        domText: sel.toString(),
        anchorText: sel.anchorNode?.textContent ?? null,
        anchorOffset: sel.anchorOffset,
        focusOffset: sel.focusOffset,
        pmFrom: pm.from,
        pmTo: pm.to,
      };
      focus(options);
    };
    const harness = (
      window as unknown as { __HARNESS__: { swapColumns(): void } }
    ).__HARNESS__;
    harness.swapColumns();
    await new Promise((r) => requestAnimationFrame(r));
    harness.swapColumns();
    await new Promise((r) => requestAnimationFrame(r));
    root.focus = focus;
    return atRefocus;
  }, DOC);
}

test("editor roots opt into anchor-based selection saving", async ({ page }) => {
  await openHarness(page);
  const root = page.locator(".ProseMirror");
  await expect(root).toHaveAttribute("data-react-selection-anchors", "");
  // Added alongside Tiptap's own attributes, never in their place.
  await expect(root).toHaveAttribute("role", "textbox");
});

test("a collapsed caret survives React moving the focused editor", async ({
  page,
}) => {
  await openHarness(page);
  await placeCaret(page, 0);
  const before = await snapshot(page);
  expect(before.focused).toBe(true);
  expect(before.pmFrom).toBe(before.pmTo);

  const restored = await moveEditor(page);
  // React refocused the editor with the caret exactly where it was.
  expect(restored).toEqual(before);
  // ProseMirror's own selection never moved.
  const after = await snapshot(page);
  expect([after.pmFrom, after.pmTo]).toEqual([before.pmFrom, before.pmTo]);

  // Typing after focusing back lands at the caret.
  await page.locator(".ProseMirror").focus();
  await page.keyboard.type("X");
  await expect
    .poll(() => getMarkdown(page))
    .toContain("Paragraph 30 alphaX bravo");
});

test("a range selection survives React moving the focused editor", async ({
  page,
}) => {
  await openHarness(page);
  await placeCaret(page, 6);
  const before = await snapshot(page);
  expect(before.focused).toBe(true);
  expect(before.domText).toBe(" bravo");

  const restored = await moveEditor(page);
  expect(restored).toEqual(before);
  const after = await snapshot(page);
  expect([after.pmFrom, after.pmTo]).toEqual([before.pmFrom, before.pmTo]);

  await page.locator(".ProseMirror").focus();
  await page.keyboard.type("!");
  await expect
    .poll(() => getMarkdown(page))
    .toContain("Paragraph 30 alpha! charlie");
});

test("the caret stays put across commits from an autosave", async ({
  page,
}) => {
  await openHarness(page);
  await placeCaret(page, 0);
  await page.keyboard.type("Q");
  // The autosave runs after a 500 ms pause and commits several times.
  await expect
    .poll(async () => (await page.evaluate(
      (path) =>
        (
          window as unknown as {
            __HARNESS__: { readFile(p: string): Promise<string | null> };
          }
        ).__HARNESS__.readFile(path),
      DOC,
    )) ?? "")
    .toContain("Paragraph 30 alphaQ bravo");
  await page.keyboard.type("R");
  await expect
    .poll(() => getMarkdown(page))
    .toContain("Paragraph 30 alphaQR bravo");
});
