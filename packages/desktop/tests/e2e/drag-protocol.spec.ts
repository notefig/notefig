/**
 * Cross-context drag-and-drop through the standardized drag protocol
 * (src/utils/drag-protocol.tsx — see docs/dnd-protocol.md) and the
 * @pierre/trees file tree's native drag engine.
 *
 * Covers every shipped interaction plus its guard rails:
 *   file row → tab bar / editor / folder / root; directory guards
 *   (no open-in-editor, no self-nesting); open-file and duplicate-target
 *   move guards; hover highlight; dnd-kit tab reorder regression; editor
 *   image → folder move with src rewrite; in-editor image move.
 *
 * Drag engines per tests/setup/drag-helpers.ts: the file tree and
 * ProseMirror image nodes are NATIVE HTML5 drag sources (tree rows are
 * additionally tagged with the protocol payload on dragstart, so protocol
 * zones outside the tree accept them); dockable tabs remain dnd-kit
 * (pointer) sources. Tree-internal moves use Playwright's real dragTo.
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
  await page.getByRole("treeitem", { name: NOTES_NAME }).click();
  await expect(page.locator(".ProseMirror")).toBeVisible({ timeout: 15_000 });
  await expect(
    page.locator(".ProseMirror h1", { hasText: "DnD Fixture" }),
  ).toBeVisible();
  await expect(page.locator(".ProseMirror")).toBeFocused({ timeout: 5_000 });
}

// Tree rows live in the @pierre/trees shadow root and are keyed by
// workspace-relative paths — directories carry a trailing slash. Playwright
// CSS pierces open shadow roots, and syntheticNativeDrag's deep query does
// too.
const treeRow = (name: string) => `[data-item-path$="${name}"]`;
const treeRowExact = (relPath: string) => `[data-item-path="${relPath}"]`;
const treeDirRow = (relPath: string) => `[data-item-path="${relPath}/"]`;

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

    await syntheticNativeDrag(
      page,
      treeRow(OTHER_NAME),
      '[data-testid="tab-bar"]',
      {
        // Tree rows are @pierre/trees' own native drag, which permits moves
        // only; the zone prefers "copy". Asserts the zone still accepts the
        // drag. It cannot reproduce the bug this guards against — a zone
        // advertising an effect the source forbids is cancelled by the
        // *browser*, which synthetic events never do (resolveDropEffect's
        // unit tests cover that) — but it does catch the zone refusing a
        // move-only drag outright.
        effectAllowed: "move",
        whileOverTarget: async () => {
          await expect(
            page.locator("[data-mtr-drop-over='true']"),
          ).toBeVisible();
        },
      },
    );

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

    await syntheticNativeDrag(
      page,
      treeDirRow(FOLDER_NAME),
      '[data-testid="tab-bar"]',
    );

    await expect(
      page.locator('[data-testid="tab-bar"]', { hasText: FOLDER_NAME }),
    ).not.toBeVisible();
  });

  test("an accepted drag highlights the tree drop zone while hovering", async ({
    page,
  }) => {
    await openNotes(page);

    // editor image (protocol image-asset source) hovering the tree: the
    // tree-wide protocol zone carries the hover attribute
    const imageWrapper = ".ProseMirror [data-drag-handle]";
    await expect(page.locator(imageWrapper)).toBeVisible();

    await syntheticNativeDrag(page, imageWrapper, treeDirRow(FOLDER_NAME), {
      whileOverTarget: async () => {
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

    await syntheticNativeDrag(page, treeRow(OTHER_NAME), ".ProseMirror > p");

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

    await syntheticNativeDrag(page, treeRow("photo.png"), ".ProseMirror > p");

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

    // synthetic drags need concrete CSS, so read the window ids
    const [firstWindowId, secondWindowId] = await page
      .locator("[data-dockable-window-id]")
      .evaluateAll((els) =>
        els.map((el) => el.getAttribute("data-dockable-window-id")),
      );

    // drop a file onto the FIRST window's editor — it must open there,
    // not in the most recently active (second) window
    await syntheticNativeDrag(
      page,
      treeRow("inside.md"),
      `[data-dockable-window-id="${firstWindowId}"] .ProseMirror`,
    );

    await expect(
      page.locator(
        `[data-dockable-window-id="${firstWindowId}"] div[title="inside.md"]`,
      ),
    ).toBeVisible({ timeout: 5_000 });
    await expect(
      page.locator(
        `[data-dockable-window-id="${secondWindowId}"] div[title="inside.md"]`,
      ),
    ).toHaveCount(0);

    // dragging an ALREADY-OPEN file onto the other window MOVES its tab
    // there (explicit placement gesture) instead of selecting it in place
    await syntheticNativeDrag(
      page,
      treeRow("inside.md"),
      `[data-dockable-window-id="${secondWindowId}"] .ProseMirror`,
    );
    await expect(
      page.locator(
        `[data-dockable-window-id="${secondWindowId}"] div[title="inside.md"]`,
      ),
    ).toBeVisible({ timeout: 5_000 });
    await expect(
      page.locator(
        `[data-dockable-window-id="${firstWindowId}"] div[title="inside.md"]`,
      ),
    ).toHaveCount(0);
  });

  test("drops still land from rows revealed by scrolling the tree", async ({
    page,
  }) => {
    // enough filler rows that the tree overflows and can actually scroll
    const filler = Array.from({ length: 60 }, (_, i) => ({
      path: `${WORKSPACE}/zz-filler-${String(i).padStart(2, "0")}.md`,
      content: `# filler ${i}\n`,
    }));
    await seedWorkspace(page, filler);
    await page.goto(`/${encodeURIComponent(WORKSPACE)}`);
    await page.getByRole("treeitem", { name: NOTES_NAME }).click();
    await expect(page.locator(".ProseMirror")).toBeVisible({
      timeout: 15_000,
    });

    // the tree is virtualized inside its shadow root: rows outside the
    // viewport are not in the DOM at all. Scroll the shadow scroller to
    // materialize a late filler row, like a user wheeling down the tree.
    await page.evaluate(() => {
      const host = document.querySelector("file-tree-container");
      const scroller = host?.shadowRoot?.querySelector(
        '[data-file-tree-virtualized-scroll]',
      );
      if (!scroller) throw new Error("missing tree scroller");
      scroller.scrollTop = scroller.scrollHeight;
    });
    const lateRow = page.locator(treeRow("zz-filler-50.md"));
    await expect(lateRow).toBeVisible();

    await syntheticNativeDrag(
      page,
      treeRow("zz-filler-50.md"),
      ".ProseMirror > p",
    );

    // the drop still lands: the filler opened as a tab
    await expect(
      page.locator('[data-testid="tab-bar"]', { hasText: "zz-filler-50.md" }),
    ).toBeVisible({ timeout: 5_000 });
  });

  test("dropping a directory row on the editor is a silent no-op", async ({
    page,
  }) => {
    await openNotes(page);

    await syntheticNativeDrag(
      page,
      treeDirRow(FOLDER_NAME),
      ".ProseMirror > p",
    );

    await expect(
      page.locator('[data-testid="tab-bar"]', { hasText: FOLDER_NAME }),
    ).not.toBeVisible();
    await expect(page.locator(".ProseMirror")).not.toContainText(
      `${WORKSPACE}/${FOLDER_NAME}`,
    );
  });
});

test.describe("tree-internal moves (@pierre/trees native drag)", () => {
  test("dropping a file row on a folder moves it into the folder", async ({
    page,
  }) => {
    await openNotes(page);

    await page
      .locator(treeRow(OTHER_NAME))
      .dragTo(page.locator(treeDirRow(FOLDER_NAME)));

    await expect(
      page.locator(treeRowExact(`${FOLDER_NAME}/other.md`)),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("dropping a nested file on a root-level file row moves it to the root", async ({
    page,
  }) => {
    await openNotes(page);

    // dropping on a file row targets that row's parent directory — here
    // the workspace root
    await page
      .locator(treeRowExact(`${FOLDER_NAME}/inside.md`))
      .dragTo(page.locator(treeRowExact(OTHER_NAME)));

    await expect(page.locator(treeRowExact("inside.md"))).toBeVisible({
      timeout: 10_000,
    });
  });

  test("dropping a file on a folder that already has that name is refused", async ({
    page,
  }) => {
    await openNotes(page);

    await page
      .locator(treeRowExact("dupe.md"))
      .dragTo(page.locator(treeDirRow(FOLDER_NAME)));

    // both files still exist at their original locations
    await page.waitForTimeout(500);
    await expect(page.locator(treeRowExact("dupe.md"))).toHaveCount(1);
    await expect(
      page.locator(treeRowExact(`${FOLDER_NAME}/dupe.md`)),
    ).toHaveCount(1);
  });

  test("a folder cannot be dropped into its own descendant", async ({
    page,
  }) => {
    await openNotes(page);

    // sub2 lives inside sub — dropping sub onto sub2's region must no-op.
    // Nested folders start collapsed; expand sub2 so its child renders.
    const sub2 = page.locator(treeDirRow(`${FOLDER_NAME}/sub2`));
    await expect(sub2).toBeVisible();
    await sub2.click();
    await expect(
      page.locator(treeRowExact(`${FOLDER_NAME}/sub2/deep.md`)),
    ).toBeVisible();

    await page.locator(treeDirRow(FOLDER_NAME)).dragTo(sub2);

    await page.waitForTimeout(500);
    await expect(
      page.locator(treeRowExact(`${FOLDER_NAME}/inside.md`)),
    ).toHaveCount(1);
    await expect(
      page.locator(treeRowExact(`${FOLDER_NAME}/sub2/deep.md`)),
    ).toHaveCount(1);
  });

  test("a file that is open in a tab moves and its tab follows", async ({
    page,
  }) => {
    await openNotes(page); // notes.md is open

    await page
      .locator(treeRowExact(NOTES_NAME))
      .dragTo(page.locator(treeDirRow(FOLDER_NAME)));

    // The move routes through the close-and-reopen rename: the file lands
    // in the folder and the open tab swaps to the new path.
    await expect(
      page.locator(treeRowExact(`${FOLDER_NAME}/${NOTES_NAME}`)),
    ).toHaveCount(1, { timeout: 10_000 });
    await expect(page.locator(treeRowExact(NOTES_NAME))).toHaveCount(0);
    await expect
      .poll(() => decodeURIComponent(page.url()), { timeout: 10_000 })
      .toContain(`${FOLDER_NAME}/${NOTES_NAME}`);
    // and the editor keeps working on the moved file
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

    await syntheticNativeDrag(page, imageWrapper, treeDirRow(FOLDER_NAME));

    // the asset file moved into the folder (tree updates via collections;
    // root-depth folders render expanded, so the child row appears directly)
    await expect(
      page.locator(treeRowExact(`${FOLDER_NAME}/photo.png`)),
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

  test("dropping an image node on a plain file row moves the asset to the root", async ({
    page,
  }) => {
    await openNotes(page);

    const imageWrapper = ".ProseMirror [data-drag-handle]";
    await expect(page.locator(imageWrapper)).toBeVisible();

    // a file row resolves to its parent directory — the workspace root
    await syntheticNativeDrag(page, imageWrapper, treeRowExact(OTHER_NAME));

    await expect(page.locator(treeRowExact("photo.png"))).toBeVisible({
      timeout: 10_000,
    });
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
    await expect(page.locator(treeRowExact("assets/photo.png"))).toHaveCount(
      1,
    );
  });
});
