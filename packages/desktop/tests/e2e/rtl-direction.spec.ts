/**
 * Per-block text direction, as the browser lays it out: a Farsi block sits
 * on the right and a Latin one on the left in the same LTR document, a
 * Farsi list item puts its marker on the right, and a block flips as it is
 * typed into. Paragraphs and headings get this from CSS (`unicode-bidi:
 * plaintext`), wrappers from a static dir="auto" (editor-schema-kit.ts).
 */
import { test, expect, type Page } from "@playwright/test";
import {
  openFileInTree,
  openWorkspace,
  seedTestFiles,
  setupTestDatabase,
  waitForFileTree,
} from "../setup/test-helpers";

const WS = "/workspace/rtl-direction";
const FARSI = "سلام دنیا، این یک متن فارسی است";
const HEADING = "عنوان فارسی";
const ITEM = "مورد فهرست";
const TYPED = "متن تازه تایپ شده";
const LATIN = "Hello world, this is Latin text";

/** Which side of its block `text` sits on: "left", "right" or "full". */
function sideOf(page: Page, text: string): Promise<string> {
  return page.evaluate((needle) => {
    const editor = Array.from(document.querySelectorAll(".ProseMirror")).find(
      (el) => (el as HTMLElement).checkVisibility({ visibilityProperty: true }),
    )!;
    const block = Array.from(
      editor.querySelectorAll("p, h1, h2, h3, h4, h5, h6"),
    ).find((el) => el.textContent === needle)!;
    const range = document.createRange();
    range.selectNodeContents(block);
    const text = range.getBoundingClientRect();
    const box = block.getBoundingClientRect();
    const gapLeft = text.left - box.left;
    const gapRight = box.right - text.right;
    if (gapLeft < 2 && gapRight < 2) return "full";
    return gapLeft < gapRight ? "left" : "right";
  }, text);
}

test.describe("per-block text direction", () => {
  test.beforeEach(async ({ page }) => {
    await setupTestDatabase(page, "rtl-direction");
    await openWorkspace(page, WS);
    await seedTestFiles(page, [
      {
        path: `${WS}/mixed.md`,
        content: [
          `# ${HEADING}`,
          "",
          FARSI,
          "",
          LATIN,
          "",
          `123 ${FARSI}`,
          "",
          `- ${ITEM}`,
          "",
          "Last line",
          "",
        ].join("\n"),
        type: "file" as const,
      },
    ]);
    await page.reload();
    await waitForFileTree(page, "mixed.md");
    await openFileInTree(page, "mixed.md");
    await expect(
      page.locator(".ProseMirror").locator("visible=true").first(),
    ).toContainText(LATIN);
  });

  test("each block lays out by its own text", async ({ page }) => {
    expect(await sideOf(page, FARSI)).toBe("right");
    expect(await sideOf(page, LATIN)).toBe("left");
    // A leading number is neutral: the first strong character decides.
    expect(await sideOf(page, `123 ${FARSI}`)).toBe("right");
    expect(await sideOf(page, HEADING)).toBe("right");
  });

  test("a Farsi list item puts its marker on the right", async ({ page }) => {
    const item = page.locator(".ProseMirror li").locator("visible=true").first();
    await expect(item).toHaveCSS("direction", "rtl");
  });

  test("a block flips as Farsi is typed into it", async ({ page }) => {
    const last = page
      .locator(".ProseMirror p", { hasText: "Last line" })
      .locator("visible=true");
    await last.click();
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await page.keyboard.type(TYPED);
    await expect.poll(() => sideOf(page, TYPED)).toBe("right");
    expect(await sideOf(page, "Last line")).toBe("left");
  });
});
