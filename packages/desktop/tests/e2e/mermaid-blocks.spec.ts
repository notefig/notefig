/**
 * A mermaid block in a document (```mermaid, see
 * @notefig/widgets/mermaid-block) is drawn as its diagram, follows the
 * app's theme, is one thing to the selection as a diff block is, and is
 * edited as its source only when asked, then saved as the code block it is.
 */
import { test, expect } from "@playwright/test";
import {
  setupTestDatabase,
  openWorkspace,
  seedTestFiles,
  waitForFileTree,
  openFileInTree,
  waitForContentSaved,
} from "../setup/test-helpers";

const DIAGRAM = "flowchart LR\n  Draft --> Review";

test("a mermaid block is drawn as its diagram, selected as one, and edited when asked @smoke", async ({ page }) => {
  const workspace = "/workspace/mermaid-blocks";
  await setupTestDatabase(page, "mermaid-blocks");
  await openWorkspace(page, workspace);
  await seedTestFiles(page, [
    { path: `${workspace}/flow.md`, content: `# Flow\n\nBefore.\n\n\`\`\`mermaid\n${DIAGRAM}\n\`\`\`\n\nAfter.\n`, type: "file" },
  ]);
  await page.reload();
  await waitForFileTree(page, "flow.md");
  await openFileInTree(page, "flow.md");
  const editor = page.locator(".ProseMirror");
  const card = editor.locator("notefig-mermaid-block [data-mermaid-card]");
  const svg = card.locator("[data-mermaid-diagram] svg");
  const source = editor.locator("> pre");
  const selected = editor.locator("notefig-mermaid-block[data-selected]");

  await expect(svg).toBeVisible();
  await expect(svg).toContainText("Draft");
  await expect(svg).toContainText("Review");
  await expect(source).toBeHidden();

  // The app's theme: Pele's text colour is the app's foreground, light or dark.
  const fg = () => svg.evaluate((element) => getComputedStyle(element).getPropertyValue("--pele-fg").trim());
  const theme = (dark: boolean) => page.evaluate((on) => document.documentElement.classList.toggle("dark", on), dark);
  const initiallyDark = await page.evaluate(() => document.documentElement.classList.contains("dark"));
  await theme(false);
  const light = await fg();
  await theme(true);
  await expect.poll(fg).not.toBe(light);
  await theme(initiallyDark);

  // An arrow off the line above selects it; the keys are on it.
  await page.locator(".ProseMirror > p", { hasText: "Before." }).click();
  await page.keyboard.press("End");
  await page.keyboard.press("ArrowDown");
  await expect(selected).toHaveCount(1);
  await expect(card.locator("[data-mermaid-edit] kbd")).toHaveText("1");

  // Enter edits it; Escape draws the edit.
  await page.keyboard.press("Enter");
  await expect(source).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("End");
  await page.keyboard.type(" --> Merged");
  await page.keyboard.press("Escape");
  await expect(source).toBeHidden();
  await expect(svg).toContainText("Merged");
  await waitForContentSaved(page, `${workspace}/flow.md`, `\`\`\`mermaid\n${DIAGRAM} --> Merged\n\`\`\``);

  // A diagram it can't read says so, and shows its source.
  await card.locator("[data-mermaid-edit]").click();
  await expect(source).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("End");
  await page.keyboard.type(" -->");
  await page.keyboard.press("Escape");
  await expect(card.locator(".pele-error")).toBeVisible();
  await expect(card.locator("pre")).toContainText("Merged -->");
});

const WIDE = `flowchart TD\n${Array.from({ length: 14 }, (_, i) => `  Root --> C${i}[Child service ${i}]`).join("\n")}`;

test("a wide diagram shrinks only so far, then scrolls from its left edge", async ({ page }) => {
  const workspace = "/workspace/mermaid-wide";
  await setupTestDatabase(page, "mermaid-wide");
  await openWorkspace(page, workspace);
  await seedTestFiles(page, [
    {
      path: `${workspace}/wide.md`,
      content: `# Wide\n\n\`\`\`mermaid\n${WIDE}\n\`\`\`\n\n\`\`\`mermaid\n${DIAGRAM}\n\`\`\`\n`,
      type: "file",
    },
  ]);
  await page.reload();
  await waitForFileTree(page, "wide.md");
  await openFileInTree(page, "wide.md");
  const areas = page.locator(".ProseMirror notefig-mermaid-block [data-mermaid-diagram]");
  await expect(areas.nth(0).locator("svg")).toBeVisible();
  await expect(areas.nth(1).locator("svg")).toBeVisible();

  const measure = (index: number) =>
    areas.nth(index).evaluate((area) => {
      const svg = area.querySelector("svg")!;
      const a = area.getBoundingClientRect();
      const s = svg.getBoundingClientRect();
      return {
        overflows: area.scrollWidth > area.clientWidth,
        scale: s.width / Number(svg.getAttribute("width")),
        leftGap: s.left - a.left,
        centreGap: Math.abs(s.left + s.width / 2 - (a.left + a.width / 2)),
      };
    });

  // The wide one: no smaller than 3/4, scrolled from its left edge.
  const wide = await measure(0);
  expect(wide.overflows).toBe(true);
  expect(wide.scale).toBeGreaterThanOrEqual(0.74);
  expect(wide.leftGap).toBeCloseTo(0, 0);

  // One that fits: centred, nothing to scroll.
  const small = await measure(1);
  expect(small.overflows).toBe(false);
  expect(small.centreGap).toBeLessThan(1);
});
