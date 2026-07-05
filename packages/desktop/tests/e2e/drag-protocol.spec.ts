/**
 * Cross-context drag-and-drop through the standardized drag protocol
 * (src/utils/drag-protocol.tsx — see docs/dnd-protocol.md).
 *
 * Covers every shipped interaction plus its guard rails:
 *   file row → tab bar / editor / folder / root; directory guards
 *   (no open-in-editor, no self-nesting); open-file and duplicate-target
 *   move guards; hover highlight; dnd-kit tab reorder regression; editor
 *   image → folder move with src rewrite; in-editor image move.
 *
 * Drag engines are driven per tests/setup/drag-helpers.ts: real pointer
 * input for dnd-kit sources, synthetic DragEvents for native sources.
 */
import { test, expect, type Page } from "@playwright/test";
import { pointerDrag, syntheticNativeDrag } from "../setup/drag-helpers";

const WORKSPACE = "/e2e-dnd-ws";
const NOTES_NAME = "notes.md";
const NOTES_PATH = `${WORKSPACE}/${NOTES_NAME}`;
const OTHER_NAME = "other.md";
const OTHER_PATH = `${WORKSPACE}/${OTHER_NAME}`;
const FOLDER_NAME = "sub";
const INSIDE_PATH = `${WORKSPACE}/${FOLDER_NAME}/inside.md`;
const DEEP_PATH = `${WORKSPACE}/${FOLDER_NAME}/sub2/deep.md`;
const DUPE_ROOT_PATH = `${WORKSPACE}/dupe.md`;
const DUPE_NESTED_PATH = `${WORKSPACE}/${FOLDER_NAME}/dupe.md`;
const ASSET_PATH = `${WORKSPACE}/assets/photo.png`;

const NOTES_FIXTURE = [
  "# DnD Fixture",
  "",
  "First paragraph as a drop target.",
  "",
  "![](assets/photo.png)",
  "",
  "Trailing paragraph.",
  "",
].join("\n");

async function seedWorkspace(page: Page) {
  await page.addInitScript(() => {
    (
      window as unknown as Record<string, unknown>
    ).__METRISTS_FORCE_INDEXEDDB__ = true;
  });

  await page.goto("/welcome");

  await page.evaluate(
    async ({ files }) => {
      const db: IDBDatabase = await new Promise((resolve, reject) => {
        const req = indexedDB.open("metrists-fs", 1);
        req.onerror = () => reject(req.error);
        req.onsuccess = () => resolve(req.result);
        req.onupgradeneeded = (event) => {
          const database = (event.target as IDBOpenDBRequest).result;
          if (!database.objectStoreNames.contains("files")) {
            database.createObjectStore("files", { keyPath: "path" });
          }
        };
      });

      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(["files"], "readwrite");
        const store = tx.objectStore("files");
        for (const { path, content } of files) {
          store.put({
            path,
            content,
            modifiedAt: new Date(),
            createdAt: new Date(),
          });
        }
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    },
    {
      files: [
        { path: NOTES_PATH, content: NOTES_FIXTURE },
        { path: OTHER_PATH, content: "# Other Doc\n\nHello.\n" },
        { path: INSIDE_PATH, content: "# Inside\n" },
        { path: DEEP_PATH, content: "# Deep\n" },
        { path: DUPE_ROOT_PATH, content: "# Dupe at root\n" },
        { path: DUPE_NESTED_PATH, content: "# Dupe in sub\n" },
        { path: ASSET_PATH, content: "not-a-real-png" },
      ],
    },
  );
}

async function openNotes(page: Page) {
  await seedWorkspace(page);
  await page.goto(`/${encodeURIComponent(WORKSPACE)}`);
  await page.getByRole("button", { name: NOTES_NAME }).click();
  await expect(page.locator(".ProseMirror")).toBeVisible({ timeout: 15_000 });
  await expect(
    page.locator(".ProseMirror h1", { hasText: "DnD Fixture" }),
  ).toBeVisible();
  await expect(page.locator(".ProseMirror")).toBeFocused({ timeout: 5_000 });
}

const treeRow = (name: string) =>
  `[data-file-tree-root] button[data-file-path$="/${name}"]`;
const treeRowExact = (path: string) =>
  `[data-file-tree-root] button[data-file-path="${path}"]`;

test.describe("drag protocol: file tree → tabs/editor", () => {
  test("dropping a file row on the tab bar opens it as a tab", async ({
    page,
  }) => {
    await openNotes(page);

    // the tab bar only renders with 2+ tabs — open a second one first
    await page.locator(treeRow("inside.md")).click({
      modifiers: ["ControlOrMeta"],
    });
    await expect(page.locator('[data-testid="tab-bar"]')).toBeVisible();

    await pointerDrag(page, treeRow(OTHER_NAME), '[data-testid="tab-bar"]');

    await expect(
      page.locator('[data-testid="tab-bar"]', { hasText: OTHER_NAME }),
    ).toBeVisible();
    // opened alongside, not instead of, the original tab
    await expect(
      page.locator('[data-testid="tab-bar"]', { hasText: NOTES_NAME }),
    ).toBeVisible();
  });

  test("dropping a directory row on the tab bar is a no-op", async ({
    page,
  }) => {
    await openNotes(page);

    await page.locator(treeRow("inside.md")).click({
      modifiers: ["ControlOrMeta"],
    });
    await expect(page.locator('[data-testid="tab-bar"]')).toBeVisible();

    await pointerDrag(page, treeRow(FOLDER_NAME), '[data-testid="tab-bar"]');

    await expect(
      page.locator('[data-testid="tab-bar"]', { hasText: FOLDER_NAME }),
    ).not.toBeVisible();
  });

  test("an accepted drag highlights the drop zone while hovering", async ({
    page,
  }) => {
    await openNotes(page);

    await pointerDrag(page, treeRow(OTHER_NAME), treeRow(FOLDER_NAME), {
      whileOverTarget: async () => {
        // the folder's subtree container carries the hover attribute
        await expect(
          page.locator("[data-mtr-drop-over='true']"),
        ).toBeVisible();
      },
    });

    // highlight clears once the drag ends
    await expect(page.locator("[data-mtr-drop-over='true']")).toHaveCount(0);
  });

  test("dropping a file row on the editor opens it without inserting text", async ({
    page,
  }) => {
    await openNotes(page);

    await pointerDrag(page, treeRow(OTHER_NAME), ".ProseMirror > p");

    await expect(
      page.locator('[data-testid="tab-bar"]', { hasText: OTHER_NAME }),
    ).toBeVisible();
    // switch back and verify the source doc was not polluted with the path
    await page
      .locator('[data-testid="tab-bar"]')
      .getByText(NOTES_NAME)
      .click();
    await expect(page.locator(".ProseMirror")).not.toContainText(OTHER_PATH);
    await expect(page.locator(".ProseMirror")).not.toContainText("file://");
  });

  test("dropping a directory row on the editor is a silent no-op", async ({
    page,
  }) => {
    await openNotes(page);

    await pointerDrag(page, treeRow(FOLDER_NAME), ".ProseMirror > p");

    await expect(
      page.locator('[data-testid="tab-bar"]', { hasText: FOLDER_NAME }),
    ).not.toBeVisible();
    await expect(page.locator(".ProseMirror")).not.toContainText(
      `${WORKSPACE}/${FOLDER_NAME}`,
    );
  });
});

test.describe("drag protocol: tree-internal moves", () => {
  test("dropping a file row on a folder moves it into the folder", async ({
    page,
  }) => {
    await openNotes(page);

    await pointerDrag(page, treeRow(OTHER_NAME), treeRow(FOLDER_NAME));

    await expect(
      page.locator(treeRowExact(`${WORKSPACE}/${FOLDER_NAME}/other.md`)),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("dropping a nested file on a plain file row moves it to the root", async ({
    page,
  }) => {
    await openNotes(page);

    // file rows aren't drop zones; the drop bubbles to the tree root zone
    await pointerDrag(page, treeRow("inside.md"), treeRow(OTHER_NAME));

    await expect(
      page.locator(treeRowExact(`${WORKSPACE}/inside.md`)),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("dropping a file on a folder that already has that name is refused", async ({
    page,
  }) => {
    await openNotes(page);

    await pointerDrag(page, treeRowExact(DUPE_ROOT_PATH), treeRow(FOLDER_NAME));

    // both files still exist at their original locations
    await page.waitForTimeout(500);
    await expect(page.locator(treeRowExact(DUPE_ROOT_PATH))).toHaveCount(1);
    await expect(page.locator(treeRowExact(DUPE_NESTED_PATH))).toHaveCount(1);
  });

  test("a folder cannot be dropped into its own descendant", async ({
    page,
  }) => {
    await openNotes(page);

    // sub2 lives inside sub — dropping sub onto sub2's region must no-op.
    // Nested folders start collapsed; expand sub2 so its child renders.
    await expect(page.locator(treeRow("sub2"))).toBeVisible();
    await page.locator(treeRow("sub2")).click();
    await expect(page.locator(treeRowExact(DEEP_PATH))).toBeVisible();

    await pointerDrag(page, treeRow(FOLDER_NAME), treeRow("sub2"));

    await page.waitForTimeout(500);
    await expect(page.locator(treeRowExact(INSIDE_PATH))).toHaveCount(1);
    await expect(page.locator(treeRowExact(DEEP_PATH))).toHaveCount(1);
  });

  test("a file that is open in a tab is not moved", async ({ page }) => {
    await openNotes(page); // notes.md is open

    await pointerDrag(page, treeRow(NOTES_NAME), treeRow(FOLDER_NAME));

    await page.waitForTimeout(500);
    // stays at the root; nothing appeared inside the folder
    await expect(page.locator(treeRowExact(NOTES_PATH))).toHaveCount(1);
    await expect(
      page.locator(treeRowExact(`${WORKSPACE}/${FOLDER_NAME}/${NOTES_NAME}`)),
    ).toHaveCount(0);
    // and the editor keeps working
    await expect(
      page.locator(".ProseMirror h1", { hasText: "DnD Fixture" }),
    ).toBeVisible();
  });
});

test.describe("drag protocol: dnd-kit tab engine coexistence", () => {
  test("dnd-kit tab reorder still works with protocol zones mounted", async ({
    page,
  }) => {
    await openNotes(page);

    // open two more tabs so the bar shows three
    await page.locator(treeRow(OTHER_NAME)).click({
      modifiers: ["ControlOrMeta"],
    });
    await page.locator(treeRow("inside.md")).click({
      modifiers: ["ControlOrMeta"],
    });
    const tabBar = page.locator('[data-testid="tab-bar"]');
    await expect(tabBar).toBeVisible();
    await expect(tabBar.getByText("inside.md")).toBeVisible();

    // tabs carry title={fileName}; read their order, reorder, assert change
    const tabTitles = () =>
      page
        .locator('[data-testid="tab-bar"] div[title]')
        .evaluateAll((els) => els.map((el) => el.getAttribute("title")));
    const before = await tabTitles();
    expect(before).toHaveLength(3);

    await pointerDrag(
      page,
      '[data-testid="tab-bar"] div[title="inside.md"]',
      `[data-testid="tab-bar"] div[title="${NOTES_NAME}"]`,
    );

    await expect.poll(tabTitles).not.toEqual(before);
    // all three tabs still present after the reorder
    await expect(tabBar.getByText(NOTES_NAME)).toBeVisible();
    await expect(tabBar.getByText(OTHER_NAME)).toBeVisible();
    await expect(tabBar.getByText("inside.md")).toBeVisible();
  });
});

test.describe("drag protocol: editor image → sidebar", () => {
  test("dropping an image node on a folder moves the asset and rewrites src", async ({
    page,
  }) => {
    await openNotes(page);

    // the fixture "png" is invalid so the node renders its broken/error
    // state — the NodeViewWrapper with data-drag-handle exists either way
    const imageWrapper = ".ProseMirror [data-drag-handle]";
    await expect(page.locator(imageWrapper)).toBeVisible();

    await syntheticNativeDrag(page, imageWrapper, treeRow(FOLDER_NAME));

    // the asset file moved into the folder (tree updates via collections;
    // root-depth folders render expanded, so the child row appears directly)
    await expect(
      page.locator(treeRowExact(`${WORKSPACE}/${FOLDER_NAME}/photo.png`)),
    ).toBeVisible({ timeout: 10_000 });

    // the document's image node now points at the new location (the src
    // rewrite dispatches after the fs move resolves — poll for the render)
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const editorEl = document.querySelector(".ProseMirror");
            const wrapper = editorEl?.querySelector("[data-drag-handle]");
            // read the node attr via the broken-image fallback text or img
            return (
              wrapper?.querySelector("img")?.getAttribute("src") ??
              wrapper?.textContent ??
              ""
            );
          }),
        { timeout: 10_000 },
      )
      .toContain("sub/photo.png");
  });

  test("dropping an image node on tree empty space moves the asset to the root", async ({
    page,
  }) => {
    await openNotes(page);

    const imageWrapper = ".ProseMirror [data-drag-handle]";
    await expect(page.locator(imageWrapper)).toBeVisible();

    // a plain file row is not a zone — the drop lands on the root zone
    await syntheticNativeDrag(page, imageWrapper, treeRow(OTHER_NAME));

    await expect(
      page.locator(treeRowExact(`${WORKSPACE}/photo.png`)),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("dragging an image within the editor still moves the node", async ({
    page,
  }) => {
    await openNotes(page);

    const imageWrapper = ".ProseMirror [data-drag-handle]";
    await expect(page.locator(imageWrapper)).toBeVisible();

    // drop on the second half of the trailing paragraph → move below it
    await syntheticNativeDrag(
      page,
      imageWrapper,
      ".ProseMirror > p:last-of-type",
    );

    // the image node still exists exactly once (moved, not duplicated/lost)
    await expect(page.locator(imageWrapper)).toHaveCount(1);
    // and no asset move happened — photo.png is still under assets/
    await expect(page.locator(treeRowExact(ASSET_PATH))).toHaveCount(1);
  });
});
