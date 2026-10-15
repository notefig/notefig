/**
 * Code blocks in a document are highlighted by the code viewer's Shiki with
 * Pierre's themes (code-highlight.ts): each token gets the light theme's
 * colour, and the dark theme's under .dark.
 */
import { test, expect } from "@playwright/test";
import {
  setupTestDatabase,
  openWorkspace,
  seedTestFiles,
  waitForFileTree,
  openFileInTree,
} from "../setup/test-helpers";

test("a code block's tokens are coloured by kind", async ({ page }) => {
  const workspace = "/workspace/code-highlighting";
  await setupTestDatabase(page, "code-highlighting");
  await openWorkspace(page, workspace);
  await seedTestFiles(page, [
    {
      path: `${workspace}/code.md`,
      content: '# Code\n\n```ts\nconst greeting = "hello";\n```\n',
      type: "file",
    },
  ]);
  await page.reload();
  await waitForFileTree(page, "code.md");
  await openFileInTree(page, "code.md");

  const code = page.locator(".ProseMirror pre code").first();
  const keyword = code.locator("span", { hasText: /^const$/ });
  const string = code.locator("span", { hasText: '"hello"' });
  // pierre-light; the grammar loads on demand, so the colours arrive late.
  await page.evaluate(() => document.documentElement.classList.remove("dark"));
  await expect(keyword).toHaveCSS("color", "rgb(166, 49, 190)", { timeout: 15_000 });
  await expect(string).toHaveCSS("color", "rgb(25, 159, 67)");

  // An edit in the block colours what it added. Made through the editor:
  // a click races the app's own focus on opening the document.
  await page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { editor } = document.querySelector(".ProseMirror") as any;
    editor.state.doc.descendants((node: any, pos: number) => {
      if (node.type.name === "codeBlock") editor.commands.insertContentAt(pos + node.nodeSize - 1, " let");
      return node.type.name !== "codeBlock";
    });
  });
  await expect(code.locator("span", { hasText: /^let$/ })).toHaveCSS("color", "rgb(166, 49, 190)");

  // pierre-dark, from the same tokens.
  await page.evaluate(() => document.documentElement.classList.add("dark"));
  await expect(keyword).toHaveCSS("color", "rgb(213, 104, 234)");
  await expect(string).toHaveCSS("color", "rgb(94, 204, 113)");
});
