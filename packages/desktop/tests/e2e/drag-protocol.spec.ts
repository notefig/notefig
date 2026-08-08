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

async function seedWorkspace(
  page: Page,
  extraFiles: { path: string; content: string }[] = [],
) {
  await page.addInitScript(() => {
    (
      window as unknown as Record<string, unknown>
    ).__NOTEFIG_FORCE_INDEXEDDB__ = true;
  });

  await page.goto("/welcome");

  await page.evaluate(
    async ({ files }) => {
      const db: IDBDatabase = await new Promise((resolve, reject) => {
        const req = indexedDB.open("notefig-fs", 1);
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
        ...extraFiles,
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

  test("dropping an image file row on the editor inserts it into the document", async ({
    page,
  }) => {
    await openNotes(page);
    // the fixture doc already contains one image node
    await expect(page.locator(".ProseMirror [data-drag-handle]")).toHaveCount(
      1,
    );

    await pointerDrag(page, treeRow("photo.png"), ".ProseMirror > p");

    // a second image node appears in the document…
    await expect(page.locator(".ProseMirror [data-drag-handle]")).toHaveCount(
      2,
    );
    // …and no tab was opened for it (still a single tab → no tab bar)
    await expect(page.locator('[data-testid="tab-bar"]')).not.toBeVisible();
    // the drop indicator never sticks after the drop
    await expect(page.locator("[data-mtr-drop-over='true']")).toHaveCount(0);
  });

  test("with two windows, an editor drop opens in the window it landed on", async ({
    page,
  }) => {
    await openNotes(page);
    await page.locator(treeRow(OTHER_NAME)).click({
      modifiers: ["ControlOrMeta"],
    });
    await expect(page.locator('[data-testid="tab-bar"]')).toBeVisible();

    // split: drag the other.md tab onto the right edge zone
    const windowBox = (await page
      .locator("[data-dockable-window-id]")
      .first()
      .boundingBox())!;
    const tabBox = (await page
      .locator('[data-testid="tab-bar"] div[title="other.md"]')
      .boundingBox())!;
    await page.mouse.move(
      tabBox.x + tabBox.width / 2,
      tabBox.y + tabBox.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(tabBox.x + tabBox.width / 2 + 15, tabBox.y + 15, {
      steps: 3,
    });
    await page.mouse.move(
      windowBox.x + windowBox.width - 8,
      windowBox.y + windowBox.height / 2,
      { steps: 12 },
    );
    await page.mouse.up();
    await expect(page.locator("[data-dockable-window-id]")).toHaveCount(2);

    // drop a file onto the FIRST window's editor — it must open there,
    // not in the most recently active (second) window
    await pointerDrag(
      page,
      treeRow("inside.md"),
      "[data-dockable-window-id] >> nth=0 >> .ProseMirror",
    );

    await expect(
      page.locator(
        '[data-dockable-window-id] >> nth=0 >> div[title="inside.md"]',
      ),
    ).toBeVisible({ timeout: 5_000 });
    await expect(
      page.locator(
        '[data-dockable-window-id] >> nth=1 >> div[title="inside.md"]',
      ),
    ).toHaveCount(0);

    // dragging an ALREADY-OPEN file onto the other window MOVES its tab
    // there (explicit placement gesture) instead of selecting it in place
    await pointerDrag(
      page,
      treeRow("inside.md"),
      "[data-dockable-window-id] >> nth=1 >> .ProseMirror",
    );
    await expect(
      page.locator(
        '[data-dockable-window-id] >> nth=1 >> div[title="inside.md"]',
      ),
    ).toBeVisible({ timeout: 5_000 });
    await expect(
      page.locator(
        '[data-dockable-window-id] >> nth=0 >> div[title="inside.md"]',
      ),
    ).toHaveCount(0);
  });

  test("drops still register after the tree scrolls mid-drag", async ({
    page,
  }) => {
    // enough filler rows that the tree overflows and can actually scroll
    const filler = Array.from({ length: 60 }, (_, i) => ({
      path: `${WORKSPACE}/zz-filler-${String(i).padStart(2, "0")}.md`,
      content: `# filler ${i}\n`,
    }));
    await seedWorkspace(page, filler);
    await page.goto(`/${encodeURIComponent(WORKSPACE)}`);
    await page.getByRole("button", { name: NOTES_NAME }).click();
    await expect(page.locator(".ProseMirror")).toBeVisible({
      timeout: 15_000,
    });

    // start dragging a row, then scroll its container mid-drag — the same
    // displacement dnd-kit's auto-scroll produces near the viewport edge
    const row = (await page.locator(treeRow(OTHER_NAME)).boundingBox())!;
    await page.mouse.move(row.x + row.width / 2, row.y + row.height / 2);
    await page.mouse.down();
    await page.mouse.move(row.x + row.width / 2 + 12, row.y + 12, {
      steps: 3,
    });

    await page.evaluate(() => {
      // the ScrollArea is the overflow-auto parent of the tree root
      const viewport =
        document.querySelector("[data-file-tree-root]")?.parentElement;
      if (!viewport) throw new Error("missing tree scroll viewport");
      viewport.scrollTop = 300;
      if (viewport.scrollTop === 0) {
        throw new Error("tree viewport did not scroll — fixture too short?");
      }
    });

    const editorBox = (await page.locator(".ProseMirror").boundingBox())!;
    await page.mouse.move(
      editorBox.x + editorBox.width / 2,
      editorBox.y + 40,
      { steps: 10 },
    );
    await page.mouse.up();

    // the drop still lands: other.md opened as a tab
    await expect(
      page.locator('[data-testid="tab-bar"]', { hasText: OTHER_NAME }),
    ).toBeVisible({ timeout: 5_000 });
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
