/**
 * Component-level tests for the markdown editing experience, run against
 * the dev-only /__harness/editor route (src/test-harness/editor-harness.tsx).
 *
 * Unlike tests/e2e/*, nothing here boots the workspace: each test loads
 * just the real TextEditor + SearchPanel against the real platform
 * adapter, configured through window.__EDITOR_HARNESS__ and observed
 * through window.__HARNESS__. Keep editor-behavior coverage here — it's
 * an order of magnitude cheaper than a full e2e test.
 */
import { test, expect, type Page } from "@playwright/test";
import { syntheticNativeDrag } from "../setup/drag-helpers";

const BASE = "/harness-ws";
const DOC = `${BASE}/doc.md`;

interface HarnessOptions {
  content?: string;
  files?: { path: string; content: string }[];
}

async function openHarness(page: Page, options: HarnessOptions = {}) {
  await page.addInitScript(
    ({ options, BASE, DOC }) => {
      (
        window as unknown as Record<string, unknown>
      ).__NOTEFIG_FORCE_INDEXEDDB__ = true;
      (window as unknown as Record<string, unknown>).__EDITOR_HARNESS__ = {
        basePath: BASE,
        filePath: DOC,
        ...options,
      };
    },
    { options, BASE, DOC },
  );
  await page.goto("/__harness/editor");
  await expect(page.locator(".ProseMirror")).toBeVisible({ timeout: 10_000 });
}

const getMarkdown = (page: Page) =>
  page.evaluate(() =>
    (
      window as unknown as {
        __HARNESS__: { getMarkdown: () => string | null };
      }
    ).__HARNESS__.getMarkdown(),
  );

const readFile = (page: Page, path: string) =>
  page.evaluate(
    (path) =>
      (
        window as unknown as {
          __HARNESS__: { readFile: (p: string) => Promise<string | null> };
        }
      ).__HARNESS__.readFile(path),
    path,
  );

test.describe("rendering & input rules", () => {
  test("renders the provided markdown", async ({ page }) => {
    await openHarness(page, {
      content: "# Hello Harness\n\nSome **bold** text.\n",
    });
    await expect(
      page.locator(".ProseMirror h1", { hasText: "Hello Harness" }),
    ).toBeVisible();
    await expect(page.locator(".ProseMirror strong")).toHaveText("bold");
  });

  test("markdown input rules: heading and list", async ({ page }) => {
    await openHarness(page, { content: "start\n" });
    const editor = page.locator(".ProseMirror");
    await editor.click();
    await page.keyboard.press("ControlOrMeta+End" as never).catch(() => {});
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("## Section");
    await page.keyboard.press("Enter");
    await page.keyboard.type("- item one");

    await expect(
      page.locator(".ProseMirror h2", { hasText: "Section" }),
    ).toBeVisible();
    await expect(
      page.locator(".ProseMirror li", { hasText: "item one" }),
    ).toBeVisible();
  });
});

test.describe("persistence", () => {
  test("autosave writes the edited markdown through the adapter", async ({
    page,
  }) => {
    await openHarness(page, { content: "# Doc\n" });
    const editor = page.locator(".ProseMirror");
    await editor.click();
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("freshly typed line");

    await expect
      .poll(() => readFile(page, DOC), { timeout: 5_000 })
      .toContain("freshly typed line");
    // serialization round-trip stays markdown
    expect(await getMarkdown(page)).toContain("# Doc");
  });
});

test.describe("frontmatter properties", () => {
  test("editing through the popover saves frontmatter without touching the body", async ({
    page,
  }) => {
    await openHarness(page, {
      content: "---\ntitle: Draft\n---\n\n# Doc\n\nBody text.\n",
    });
    // The yaml never renders in the document itself.
    await expect(page.locator(".ProseMirror")).not.toContainText("Draft");

    await page.getByRole("radio", { name: "Properties" }).click();
    const popover = page.getByRole("dialog");
    await expect(
      popover.getByRole("textbox", { name: "Property name title" }),
    ).toBeVisible();

    // Edit the existing value.
    const valueInput = popover.getByRole("textbox", { name: "Value of title" });
    await valueInput.fill("Final");
    await valueInput.press("Enter");

    // Add a new property.
    await popover.getByRole("textbox", { name: "New property name" }).fill("status");
    await popover.getByRole("textbox", { name: "New property value" }).fill("done");
    await popover.getByRole("textbox", { name: "New property value" }).press("Enter");

    await expect
      .poll(() => readFile(page, DOC), { timeout: 5_000 })
      .toBe("---\ntitle: Final\nstatus: done\n---\n\n# Doc\n\nBody text.");

    // Delete both properties: the fences must leave the file entirely.
    await popover.getByRole("button", { name: "Delete title" }).click();
    await popover.getByRole("button", { name: "Delete status" }).click();
    await expect
      .poll(() => readFile(page, DOC), { timeout: 5_000 })
      .toBe("# Doc\n\nBody text.");
  });

  test("toolbar button toggles the popover closed instead of reopening", async ({
    page,
  }) => {
    await openHarness(page, { content: "---\ntitle: Draft\n---\n\n# Doc\n" });
    const button = page.getByRole("radio", { name: "Properties" });

    await button.click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await button.click();
    await expect(page.getByRole("dialog")).not.toBeVisible();
    await button.click();
    await expect(page.getByRole("dialog")).toBeVisible();
  });

  test("undoing a hidden frontmatter change opens the popover", async ({
    page,
  }) => {
    await openHarness(page, { content: "---\ntitle: Draft\n---\n\n# Doc\n" });
    const button = page.getByRole("radio", { name: "Properties" });

    await button.click();
    const valueInput = page
      .getByRole("dialog")
      .getByRole("textbox", { name: "Value of title" });
    await valueInput.fill("Final");
    await valueInput.press("Enter");
    await button.click();
    await expect(page.getByRole("dialog")).not.toBeVisible();

    // Let the autosave land, then undo through the editor command (the
    // ⌘Z→undo binding is stock tiptap; synthetic modifier keystrokes are
    // unreliable in the harness right after popover focus juggling).
    await expect
      .poll(() => readFile(page, DOC), { timeout: 5_000 })
      .toContain("title: Final");
    await page.locator(".ProseMirror").click();
    await page.evaluate(() => {
      const dom = document.querySelector(".ProseMirror") as unknown as {
        editor: { commands: { undo: () => boolean } };
      };
      dom.editor.commands.undo();
    });

    // The change is invisible in the page, so the popover opens to show it.
    await expect(
      page.getByRole("dialog").getByRole("textbox", { name: "Value of title" }),
    ).toHaveValue("Draft");
    expect(await getMarkdown(page)).toContain("title: Draft");
  });
});

test.describe("images", () => {
  const PNG_BYTES = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

  test("pasting an image writes an asset and inserts the node", async ({
    page,
  }) => {
    await openHarness(page);
    await page.locator(".ProseMirror").click();

    await page.evaluate((bytes) => {
      const file = new File([new Uint8Array(bytes)], "shot.png", {
        type: "image/png",
      });
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      document.querySelector(".ProseMirror")!.dispatchEvent(
        new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData: dataTransfer,
        }),
      );
    }, PNG_BYTES);

    // node appears (broken-image fallback is fine — bytes aren't a real png)
    await expect(
      page.locator(".ProseMirror [data-drag-handle]"),
    ).toBeVisible();
    // and the asset was written under <basePath>/assets/
    await expect
      .poll(() => getMarkdown(page), { timeout: 5_000 })
      .toMatch(/assets\/pasted-\d+\.png/);
  });

  test("dropping an image file inserts a node with a deduped asset name", async ({
    page,
  }) => {
    await openHarness(page);

    await page.evaluate((bytes) => {
      const file = new File([new Uint8Array(bytes)], "photo.png", {
        type: "image/png",
      });
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      const target = document.querySelector(".ProseMirror p")!;
      const rect = target.getBoundingClientRect();
      target.dispatchEvent(
        new DragEvent("drop", {
          bubbles: true,
          cancelable: true,
          dataTransfer,
          clientX: rect.left + 5,
          clientY: rect.top + 5,
        }),
      );
    }, PNG_BYTES);

    await expect
      .poll(() => getMarkdown(page), { timeout: 5_000 })
      .toContain("assets/photo.png");
    expect(await readFile(page, `${BASE}/assets/photo.png`)).not.toBeNull();
  });

  test("block drag handle reorders content", async ({ page }) => {
    await openHarness(page, {
      content: "First paragraph.\n\nSecond paragraph.\n",
    });
    await page
      .locator(".ProseMirror p", { hasText: "First paragraph" })
      .hover();
    await expect(page.locator(".drag-handle")).toBeVisible();

    await syntheticNativeDrag(
      page,
      ".drag-handle",
      ".ProseMirror > p:nth-of-type(2)",
    );

    const paragraphs = page.locator(".ProseMirror > p");
    await expect(paragraphs.nth(0)).toContainText("Second paragraph");
    await expect(paragraphs.nth(1)).toContainText("First paragraph");
  });
});

test.describe("native format events", () => {
  const dispatchFormat = (page: Page, inputType: string) =>
    page.evaluate((inputType) => {
      const event = new InputEvent("beforeinput", {
        inputType,
        bubbles: true,
        cancelable: true,
      });
      document.querySelector(".ProseMirror")!.dispatchEvent(event);
      return event.defaultPrevented;
    }, inputType);

  // Selecting via the harness (through the editor) rather than keyboard or
  // mouse: browser-driven selection reaches ProseMirror asynchronously via
  // selectionchange, which races with the synchronous dispatch below.
  const selectAll = (page: Page) =>
    page.evaluate(() =>
      (
        window as unknown as { __HARNESS__: { selectAll: () => void } }
      ).__HARNESS__.selectAll(),
    );

  test("OS Font menu inputTypes apply the matching marks", async ({
    page,
  }) => {
    await openHarness(page, { content: "styled\n" });
    await selectAll(page);

    expect(await dispatchFormat(page, "formatBold")).toBe(true);
    await expect(page.locator(".ProseMirror strong")).toHaveText("styled");

    await dispatchFormat(page, "formatUnderline");
    await dispatchFormat(page, "formatStrikeThrough");

    const markdown = await getMarkdown(page);
    expect(markdown).toContain("**");
    expect(markdown).toContain("<u>");
    expect(markdown).toContain("~~");
  });

  test("unmapped format inputTypes are swallowed without changes", async ({
    page,
  }) => {
    await openHarness(page, { content: "plain\n" });
    await selectAll(page);

    const before = await getMarkdown(page);
    expect(await dispatchFormat(page, "formatJustifyCenter")).toBe(true);
    expect(await getMarkdown(page)).toBe(before);
  });
});

test.describe("search", () => {
  test("finds matches across workspace files and opens them", async ({
    page,
  }) => {
    await openHarness(page, {
      content: "# Doc\n\nneedle in the open doc\n",
      files: [
        { path: `${BASE}/notes/a.md`, content: "# A\n\na needle here\n" },
        { path: `${BASE}/notes/b.md`, content: "# B\n\nnothing to see\n" },
      ],
    });

    const input = page.getByPlaceholder(/search/i).first();
    await input.fill("needle");

    // matches from both the open doc and the seeded file, not from b.md
    await expect(page.getByText("a.md")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("doc.md")).toBeVisible();
    await expect(page.getByText("b.md")).not.toBeVisible();

    // clicking a match in another file routes through openFile
    await page.getByText("a needle here").click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (
              window as unknown as {
                __HARNESS__: { opened: { tabId: string }[] };
              }
            ).__HARNESS__.opened.map((o) => o.tabId),
        ),
      )
      .toContain(`${BASE}/notes/a.md`);
  });

  test("clicking a match places the cursor on that occurrence", async ({
    page,
  }) => {
    // Markdown-rich doc where the raw file has many lines (fences, table
    // delimiter rows, blank lines) that don't exist in the rendered text —
    // the clicked occurrence must still be the one selected.
    await openHarness(page, {
      content: [
        "# Notes",
        "",
        "The first needle sits here.",
        "",
        "```js",
        "const app = start();",
        "```",
        "",
        "| Key | Value |",
        "| --- | ----- |",
        "| a   | 1     |",
        "",
        "The second needle sits here.",
        "",
        "The third needle sits here.",
        "",
      ].join("\n"),
    });

    const input = page.getByPlaceholder(/search/i).first();
    await input.fill("needle");

    // The search rows render the raw line content; scope to buttons so we
    // don't click the editor's copy of the same text.
    await page
      .locator("button", { hasText: "The first needle sits here." })
      .click();

    await expect
      .poll(() =>
        page.evaluate(() => {
          const sel = window.getSelection();
          return {
            text: sel?.toString() ?? "",
            block:
              sel?.anchorNode?.parentElement?.closest("p")?.textContent ?? "",
          };
        }),
      )
      .toEqual({
        text: "needle",
        block: "The first needle sits here.",
      });
  });
});
