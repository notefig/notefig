/**
 * A diff block in a document (```ts diff, see @notefig/widgets/diff-block)
 * is drawn as its card, is one thing to the selection — a click or an
 * arrow selects it, a selection takes it in whole — and is edited as its
 * source only when asked (Enter, its Edit button), then saved as the code
 * block it is.
 */
import { test, expect, type Page } from "@playwright/test";
import {
  setupTestDatabase,
  openWorkspace,
  seedTestFiles,
  waitForFileTree,
  openFileInTree,
  waitForContentSaved,
} from "../setup/test-helpers";

const PATCH = (before: string) =>
  `--- src/greet.ts\n+++ src/greet.ts\n@@ -1 +1 @@\n-${before}\n+const greeting = "hello";`;
const BLOCK = `\`\`\`ts diff\n${PATCH('const greeting = "hi";')}\n\`\`\``;

async function openChange(page: Page, workspace: string, name: string) {
  await setupTestDatabase(page, name);
  await openWorkspace(page, workspace);
  await seedTestFiles(page, [
    { path: `${workspace}/change.md`, content: `# Change\n\nBefore.\n\n${BLOCK}\n\nAfter.\n`, type: "file" },
    { path: `${workspace}/src/greet.ts`, content: 'const greeting = "hi";\n', type: "file" },
  ]);
  await page.reload();
  await waitForFileTree(page, "change.md");
  await openFileInTree(page, "change.md");
  const editor = page.locator(".ProseMirror");
  return {
    editor,
    card: editor.locator("notefig-diff-block [data-diff-card]"),
    diff: editor.locator("notefig-diff-block diffs-container"),
    source: editor.locator("> pre"),
    selected: editor.locator("notefig-diff-block[data-selected]"),
  };
}

const line = (type: "deletion" | "addition") => `[data-line-type="change-${type}"]:not([data-column-number])`;

test("a diff block is drawn as its card, selected as one, and edited when asked @smoke", async ({ page }) => {
  const workspace = "/workspace/diff-blocks";
  const { editor, card, diff, source, selected } = await openChange(page, workspace, "diff-blocks");

  await expect(card).toContainText("src/greet.ts");
  await expect(card).toContainText("+1");
  await expect(diff.locator(line("deletion")).first()).toContainText('"hi"');
  await expect(diff.locator(line("addition")).first()).toContainText('"hello"');
  await expect(source).toBeHidden();

  // Side by side where there is room for both sides, one column where not.
  const layout = diff.locator("pre[data-diff-type]");
  await expect(layout).toHaveAttribute("data-diff-type", "split");
  const viewport = page.viewportSize()!;
  await page.setViewportSize({ width: 560, height: viewport.height });
  await expect(layout).toHaveAttribute("data-diff-type", "single");
  await page.setViewportSize(viewport);
  await expect(layout).toHaveAttribute("data-diff-type", "split");

  // The app's theme, not the OS's: the e2e browser prefers light.
  const scheme = () => diff.evaluate((element) => getComputedStyle(element).colorScheme);
  await page.evaluate(() => document.documentElement.classList.add("dark"));
  await expect.poll(scheme).toContain("dark");
  await page.evaluate(() => document.documentElement.classList.remove("dark"));
  await expect.poll(scheme).not.toContain("dark");

  // A click selects it; it stays drawn, and the keys are on it: each
  // control shows its digit, as a prompt's choices do.
  const keys = card.locator("[data-diff-key]");
  await expect(keys).toHaveCount(0);
  await diff.locator(line("addition")).first().click();
  await expect(selected).toHaveCount(1);
  await expect(source).toBeHidden();
  await expect(keys).toHaveText(["1", "2"]);
  await expect(card.locator("[data-diff-edit] [data-diff-key]")).toHaveText("2");

  // 2 edits it, as Enter does; Escape selects it again, the edit drawn.
  await page.keyboard.press("2");
  await expect(source).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(selected).toHaveCount(1);
  await page.keyboard.press("Enter");
  await expect(source).toBeVisible();
  await expect(diff).toHaveCount(0);
  await expect(source).toContainText("@@ -1 +1 @@");
  for (let row = 0; row < 3; row++) await page.keyboard.press("ArrowDown");
  await page.keyboard.press("End");
  await page.keyboard.type(" // was hi");
  await page.keyboard.press("Escape");
  await expect(source).toBeHidden();
  await expect(selected).toHaveCount(1);
  await expect(diff.locator(line("deletion")).first()).toContainText("// was hi");
  await waitForContentSaved(
    page,
    `${workspace}/change.md`,
    `\`\`\`ts diff\n${PATCH('const greeting = "hi"; // was hi')}\n\`\`\``,
  );

  // An arrow off the line above selects it, rather than skipping it.
  await editor.getByText("Before.").click();
  await expect(selected).toHaveCount(0);
  await page.keyboard.press("End");
  await page.keyboard.press("ArrowDown");
  await expect(selected).toHaveCount(1);

  // Its Edit button is the other way in; leaving draws it again.
  await card.locator("[data-diff-edit]").click();
  await expect(source).toBeVisible();
  await editor.getByText("After.").click();
  await expect(source).toBeHidden();
  await expect(selected).toHaveCount(0);
});

test("a diff block links its file, and a selection takes it in whole as a reference", async ({ page }) => {
  const { editor, card, diff, selected } = await openChange(page, "/workspace/diff-links", "diff-links");

  // A drag from the text into the diff takes the whole block in.
  const from = await editor.getByText("Before.").boundingBox();
  const to = await diff.locator(line("deletion")).first().boundingBox();
  await page.mouse.move(from!.x + 2, from!.y + from!.height / 2);
  await page.mouse.down();
  await page.mouse.move(to!.x + to!.width / 2, to!.y + to!.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(selected).toHaveCount(1);

  // "/" over it summons a prompt referencing the selection, diff and all.
  await page.keyboard.type("/");
  await expect(editor.locator('[data-type="ai-prompt"]')).toHaveCount(1);
  const reference = await page.evaluate(() => {
    const { editor: tiptap } = document.querySelector(".ProseMirror") as unknown as {
      editor: { state: { doc: { descendants(f: (node: { type: { name: string }; attrs: Record<string, unknown> }) => void): void } } };
    };
    let text: string | null = null;
    tiptap.state.doc.descendants((node) => {
      if (node.type.name === "aiPrompt") text = (node.attrs.reference as { text: string } | null)?.text ?? null;
    });
    return text;
  });
  expect(reference).toContain("efore.");
  expect(reference).toContain('+const greeting = "hello";');

  // Its header names the workspace file, with the file's type icon, and
  // opens it: a click, or its digit while the block is selected.
  await expect(card.locator("svg use")).toHaveAttribute("href", /#/);
  const tabBar = page.locator('[data-testid="tab-bar"]');
  await diff.locator(line("addition")).first().click();
  await expect(selected).toHaveCount(1);
  await page.keyboard.press("1");
  await expect(tabBar).toContainText("greet.ts");
});
