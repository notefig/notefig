import { expect, Page } from "@playwright/test";

/**
 * Test Helpers for Notefig E2E Tests
 *
 * FIXTURE PATTERN:
 * Each test file should have a corresponding .fixture.ts file:
 *   - workspace-navigation.spec.ts → workspace-navigation.fixture.ts
 *   - file-editing.spec.ts → file-editing.fixture.ts
 *
 * This makes it clear which test data belongs to which test suite.
 */

/**
 * Sets up a unique IndexedDB database name for test isolation
 * Call this in beforeEach to ensure each test gets its own database
 */
export async function setupTestDatabase(page: Page, testName: string) {
  const dbName = `metrists-test-${testName.replace(/[^a-zA-Z0-9]/g, "-")}`;
  await page.addInitScript((name) => {
    (window as any).__VITE_INDEXEDDB_NAME__ = name;
  }, dbName);
  return dbName;
}

/**
 * Seeds the browser's IndexedDB with test files
 * This simulates having a workspace with files already present
 */
export async function seedTestFiles(
  page: Page,
  files: Array<{ path: string; content: string; type: "file" | "directory" }>,
) {
  await page.evaluate(async (testFiles) => {
    const dbName = (window as any).__VITE_INDEXEDDB_NAME__ || "notefig-fs";
    const request = indexedDB.open(dbName, 1);

    return new Promise<void>((resolve, reject) => {
      request.onerror = () => reject(request.error);

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains("files")) {
          db.createObjectStore("files", { keyPath: "path" });
        }
      };

      request.onsuccess = () => {
        const db = request.result;
        const transaction = db.transaction(["files"], "readwrite");
        const store = transaction.objectStore("files");

        testFiles.forEach((file) => {
          // Directories are implied by file paths in the IndexedDB adapter
          // (createDirectories is a no-op there); a directory ROW would be
          // listed as a file by the adapter's key scan, making the same
          // path both a file and a directory — the file tree rejects that.
          // Seed a hidden placeholder child instead so empty directories
          // still materialize via the prefix scan.
          const path =
            file.type === "directory" ? `${file.path}/.keep` : file.path;
          store.put({
            path,
            content: file.content || "",
            type: "file",
            size: (file.content || "").length,
            modified: Date.now(),
          });
        });

        transaction.oncomplete = () => {
          db.close();
          resolve();
        };
        transaction.onerror = () => reject(transaction.error);
      };
    });
  }, files);
}

/**
 * Waits for the file tree to be visible and rendered
 * Checks for the presence of file/folder buttons which indicate the tree has loaded
 * Optionally waits for a specific file to appear
 */
export async function waitForFileTree(page: Page, fileName?: string) {
  // Wait for the workspace to load by checking for either:
  // 1. A specific file button (if fileName provided)
  // 2. Any file/folder button (if workspace has files)
  // 3. The "New file" button (if workspace is empty)

  if (fileName) {
    // Wait for specific file to appear in tree (shadow-piercing role query)
    await page
      .getByRole("treeitem", { name: fileName })
      .first()
      .waitFor({ timeout: 10000 });
  } else {
    // Wait for workspace controls to appear
    await page.waitForSelector('button:has-text("New file")', {
      timeout: 10000,
    });
  }
}

/**
 * Opens a workspace by clicking the "Open Folder" button and selecting a path
 * Note: This is a mock implementation for browser adapter
 */
export async function openWorkspace(page: Page, workspacePath: string) {
  // In browser mode, we'll need to mock the directory picker
  // For now, we'll navigate directly to the workspace URL
  const encodedPath = encodeURIComponent(workspacePath);
  await page.goto(`/${encodedPath}`);
}

/**
 * Clicks on a file in the file tree to open it
 * Only clicks on files (not directories) by checking for presence of file icon
 */
export async function openFileInTree(
  page: Page,
  fileName: string,
  options: { waitForEditor?: boolean } = {},
) {
  const { waitForEditor = true } = options;
  // Tree rows render in the @pierre/trees shadow root with role="treeitem"
  // and the file name as the accessible name (visible text is split into
  // truncation spans, so :has-text is unreliable). Role queries pierce
  // open shadow roots.
  const fileButton = page.getByRole("treeitem", { name: fileName }).first();

  await fileButton.waitFor({ timeout: 5000 });

  if (!waitForEditor) {
    // Caller expects no editor to mount (e.g. a failing content read).
    await fileButton.click();
    await page.waitForTimeout(300);
    return;
  }

  // A click during a layout shift (initial mount, tab re-parenting) can
  // land without a tab ever becoming visible, which read helpers then see
  // as an empty editor forever. Retry the user action until an editor is
  // actually visible — the standard self-healing pattern for compound UI
  // actions under parallel-suite load.
  await expect(async () => {
    await fileButton.click();
    await expect(page.locator('[role="textbox"]:visible').first()).toBeVisible({
      timeout: 2000,
    });
  }).toPass({ timeout: 15_000 });

  // Let the navigation/URL update settle
  await page.waitForTimeout(300);
}

/**
 * Opens a file in a new tab via the context menu.
 * More reliable than modifier clicks for cross-platform testing.
 */
export async function openFileInNewTab(page: Page, fileName: string) {
  const fileButton = page.getByRole("treeitem", { name: fileName }).first();

  await fileButton.waitFor({ timeout: 5000 });
  await fileButton.click({ button: "right" });
  await page.locator('[role="menuitem"]:has-text("Open in New Tab")').click();

  // Wait a bit for the navigation/URL update to complete
  await page.waitForTimeout(300);
}

/**
 * Gets the content of the currently active editor
 */
export async function getEditorContent(page: Page): Promise<string> {
  // Wait for at least one editor to exist (they might be display:none)
  await page.waitForSelector('[role="textbox"]', {
    state: "attached",
    timeout: 10000,
  });

  // Give a moment for visibility state to update
  await page.waitForTimeout(200);

  return page.evaluate(() => {
    // Get all editors and find the visible one (not display:none)
    const editors = Array.from(document.querySelectorAll('[role="textbox"]'));
    const visibleEditor = editors.find((el) => {
      const style = window.getComputedStyle(el as Element);
      return style.display !== "none";
    });
    return visibleEditor?.textContent || "";
  });
}

/**
 * Types text into the active editor
 */
export async function typeInEditor(page: Page, text: string) {
  // Find the visible editor
  const editor = page.locator('[role="textbox"]').first();
  await editor.click();
  await editor.pressSequentially(text);
}

/**
 * Clears the IndexedDB database for the current test
 */
export async function clearTestDatabase(page: Page) {
  await page.evaluate(() => {
    const dbName = (window as any).__VITE_INDEXEDDB_NAME__ || "notefig-fs";
    return new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(dbName);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  });
}

/**
 * Waits for content to be saved to IndexedDB
 * Useful after typing to ensure debounced save completed
 */
export async function waitForContentSaved(
  page: Page,
  filePath: string,
  expectedContent: string,
  timeout: number = 10000,
) {
  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    const content = await getFileContentFromDB(page, filePath);
    if (content && content.includes(expectedContent)) {
      return true;
    }
    await page.waitForTimeout(100);
  }
  throw new Error(
    `Content not saved to IndexedDB within ${timeout}ms for ${filePath}`,
  );
}

/**
 * Gets file content directly from IndexedDB
 */
export async function getFileContentFromDB(
  page: Page,
  filePath: string,
): Promise<string | null> {
  return page.evaluate(async (path) => {
    const dbName = (window as any).__VITE_INDEXEDDB_NAME__ || "notefig-fs";
    return new Promise<string | null>((resolve, reject) => {
      const request = indexedDB.open(dbName, 1);

      request.onerror = () => reject(request.error);

      request.onsuccess = () => {
        const db = request.result;
        const transaction = db.transaction(["files"], "readonly");
        const store = transaction.objectStore("files");
        const getRequest = store.get(path);

        getRequest.onsuccess = () => {
          const result = getRequest.result;
          db.close();
          resolve(result?.content || null);
        };

        getRequest.onerror = () => {
          db.close();
          reject(getRequest.error);
        };
      };
    });
  }, filePath);
}

/**
 * Expands a directory in the file tree
 * Directories have Folder/FolderOpen icons (not FileText icons like files)
 */
export async function expandDirectory(page: Page, dirName: string) {
  // Directory rows are treeitems in the tree's shadow root with a real
  // aria-expanded state.
  const dirButton = page.getByRole("treeitem", { name: dirName }).first();
  const expanded = await dirButton.getAttribute("aria-expanded");

  if (expanded !== "true") {
    await dirButton.click();
    // Wait a bit for expansion re-render
    await page.waitForTimeout(200);
  }
}

/**
 * Switches to a specific tab by file name
 */
export async function switchToTab(page: Page, fileName: string) {
  const tab = page.locator(`button[role="tab"]:has-text("${fileName}")`);
  await tab.click();
}

/**
 * Closes a tab by file name
 */
export async function closeTab(page: Page, fileName: string) {
  const closeButton = page.locator(
    `button[role="tab"]:has-text("${fileName}") ~ button[aria-label="Close"]`,
  );
  await closeButton.click();
}

/**
 * Gets all open tab names
 */
export async function getOpenTabs(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const tabs = Array.from(document.querySelectorAll('button[role="tab"]'));
    return tabs
      .map((tab) => {
        // Get the first generic/div child which contains just the file name
        const firstChild = tab.querySelector(":scope > *:first-child");
        return firstChild?.textContent?.trim() || "";
      })
      .filter((name) => name.length > 0);
  });
}

/**
 * Clears editor content and types new content
 */
export async function replaceEditorContent(page: Page, newContent: string) {
  // Find the visible editor (not display:none)
  const editor = page
    .locator('[role="textbox"]')
    .locator("visible=true")
    .first();
  await editor.waitFor({ state: "visible", timeout: 5000 });
  await editor.click();

  // Select all and delete
  await page.keyboard.press("Meta+a");
  await page.keyboard.press("Backspace");

  // Wait a bit for the deletion to register
  await page.waitForTimeout(100);

  // Type new content
  await editor.pressSequentially(newContent, { delay: 10 });
}

/**
 * Waits for auto-save debounce to complete
 * Default: 500ms debounce + 500ms buffer = 1000ms total
 */
export async function waitForAutoSave(page: Page, debounceMs: number = 500) {
  // Wait for debounce delay + extra buffer for IndexedDB write
  await page.waitForTimeout(debounceMs + 500);
}

/**
 * Gets file content from IndexedDB for a specific workspace
 * Useful for verifying persistence independently of editor UI
 */
export async function getIndexedDBContent(
  page: Page,
  workspacePath: string,
  filePath: string,
): Promise<string> {
  return page.evaluate(
    async ({ dbName, path }) => {
      const request = indexedDB.open(dbName, 1);

      return new Promise<string>((resolve, reject) => {
        request.onerror = () => reject(request.error);

        request.onsuccess = () => {
          const db = request.result;
          const transaction = db.transaction(["files"], "readonly");
          const store = transaction.objectStore("files");
          const getRequest = store.get(path);

          getRequest.onsuccess = () => {
            const result = getRequest.result;
            db.close();
            resolve(result?.content || "");
          };

          getRequest.onerror = () => {
            db.close();
            reject(getRequest.error);
          };
        };
      });
    },
    {
      dbName: (await page.evaluate(
        () => (window as any).__VITE_INDEXEDDB_NAME__ || "notefig-fs",
      )) as string,
      path: filePath,
    },
  );
}

/**
 * Files directly in the workspace's scratchpads folder (path + content).
 * Scratchpad names are generated (random friendly names), so tests discover
 * them by folder membership and content instead of hardcoding basenames.
 */
export async function listScratchpadFiles(
  page: Page,
  workspacePath: string,
): Promise<{ path: string; content: string }[]> {
  const prefix = `${workspacePath}/.notefig/scratchpads/`;
  return page.evaluate(async (dirPrefix) => {
    const dbName = (window as any).__VITE_INDEXEDDB_NAME__ || "notefig-fs";
    return new Promise<{ path: string; content: string }[]>(
      (resolve, reject) => {
        const request = indexedDB.open(dbName, 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const store = db
            .transaction(["files"], "readonly")
            .objectStore("files");
          const getAll = store.getAll();
          getAll.onsuccess = () => {
            const rows = (getAll.result ?? []) as {
              path?: string;
              content?: string;
              type?: string;
            }[];
            db.close();
            resolve(
              rows
                .filter(
                  (row) =>
                    row.type !== "directory" &&
                    typeof row.path === "string" &&
                    row.path.startsWith(dirPrefix) &&
                    !row.path.slice(dirPrefix.length).includes("/"),
                )
                .map((row) => ({
                  path: row.path as string,
                  content: row.content ?? "",
                })),
            );
          };
          getAll.onerror = () => {
            db.close();
            reject(getAll.error);
          };
        };
      },
    );
  }, prefix);
}

/**
 * Simulates external file change by directly modifying IndexedDB
 * Used to test file watcher functionality
 */
export async function simulateExternalFileChange(
  page: Page,
  filePath: string,
  newContent: string,
) {
  await page.evaluate(
    async ({ path, content }) => {
      const dbName = (window as any).__VITE_INDEXEDDB_NAME__ || "notefig-fs";
      const request = indexedDB.open(dbName, 1);

      return new Promise<void>((resolve, reject) => {
        request.onerror = () => reject(request.error);

        request.onsuccess = () => {
          const db = request.result;
          const transaction = db.transaction(["files"], "readwrite");
          const store = transaction.objectStore("files");

          const getRequest = store.get(path);

          getRequest.onsuccess = () => {
            const existing = getRequest.result;
            if (existing) {
              store.put({
                ...existing,
                content,
                modified: Date.now(),
                size: content.length,
              });
            }

            transaction.oncomplete = () => {
              db.close();
              resolve();
            };
          };

          getRequest.onerror = () => reject(getRequest.error);
        };
      });
    },
    { path: filePath, content: newContent },
  );
}

/**
 * Simulates external file creation
 */
export async function simulateExternalFileCreation(
  page: Page,
  filePath: string,
  content: string,
  type: "file" | "directory" = "file",
) {
  await page.evaluate(
    async ({ path, fileContent, fileType }) => {
      const dbName = (window as any).__VITE_INDEXEDDB_NAME__ || "notefig-fs";
      const request = indexedDB.open(dbName, 1);

      return new Promise<void>((resolve, reject) => {
        request.onerror = () => reject(request.error);

        request.onsuccess = () => {
          const db = request.result;
          const transaction = db.transaction(["files"], "readwrite");
          const store = transaction.objectStore("files");

          store.put({
            path,
            content: fileContent || "",
            type: fileType,
            size: fileType === "file" ? fileContent.length : 0,
            modified: Date.now(),
          });

          transaction.oncomplete = () => {
            db.close();
            resolve();
          };

          transaction.onerror = () => reject(transaction.error);
        };
      });
    },
    { path: filePath, fileContent: content, fileType: type },
  );
}

/**
 * Simulates external file deletion
 */
export async function simulateExternalFileDeletion(
  page: Page,
  filePath: string,
) {
  await page.evaluate(async (path) => {
    const dbName = (window as any).__VITE_INDEXEDDB_NAME__ || "notefig-fs";
    const request = indexedDB.open(dbName, 1);

    return new Promise<void>((resolve, reject) => {
      request.onerror = () => reject(request.error);

      request.onsuccess = () => {
        const db = request.result;
        const transaction = db.transaction(["files"], "readwrite");
        const store = transaction.objectStore("files");

        store.delete(path);

        transaction.oncomplete = () => {
          db.close();
          resolve();
        };

        transaction.onerror = () => reject(transaction.error);
      };
    });
  }, filePath);
}

/**
 * Creates a new file through the UI
 */
export async function createNewFile(
  page: Page,
  fileName: string,
  folderPath?: string,
) {
  // Click "New file" button or right-click folder
  if (folderPath) {
    // Right-click on folder, create via the context menu
    const folderButton = page
      .getByRole("treeitem", { name: folderPath.split("/").pop()! })
      .first();
    await folderButton.click({ button: "right" });
    await page.locator('[role="menuitem"]:has-text("New File")').click();
  } else {
    // Click main "New file" button
    await page.getByRole("button", { name: "New file" }).click();
  }

  // Creation is an inline rename of a placeholder row in the tree's shadow
  // root, pre-filled with "untitled.md".
  const createInput = page.locator("file-tree-container input");
  await createInput.waitFor({ timeout: 5000 });
  await createInput.fill(fileName);
  await createInput.press("Enter");
  await page.waitForTimeout(300);
}

/**
 * Right-clicks on a file in the tree
 */
export async function rightClickFile(page: Page, fileName: string) {
  const fileButton = page.getByRole("treeitem", { name: fileName }).first();
  await fileButton.click({ button: "right" });
}

/**
 * Checks if a file exists in the file tree
 */
export async function fileExistsInTree(
  page: Page,
  fileName: string,
): Promise<boolean> {
  const fileButton = page.getByRole("treeitem", { name: fileName }).first();
  return await fileButton.isVisible().catch(() => false);
}

/**
 * Drags a file to a folder in the file tree
 */
export async function dragFileToFolder(
  page: Page,
  fileName: string,
  folderName: string,
) {
  const fileButton = page.getByRole("treeitem", { name: fileName }).first();
  const folderButton = page.getByRole("treeitem", { name: folderName }).first();

  // Perform drag and drop (the tree's native HTML5 drag engine)
  await fileButton.dragTo(folderButton);
}

/**
 * Waits for file watcher to detect changes
 * BrowserFileWatcher polls every 5s for metadata, 3s for content
 */
export async function waitForWatcherDetection(
  page: Page,
  type: "metadata" | "content" = "metadata",
) {
  // Wait for polling interval + buffer
  const waitTime = type === "metadata" ? 5500 : 3500;
  await page.waitForTimeout(waitTime);
}

/**
 * Gets the current theme (light/dark)
 */
export async function getCurrentTheme(page: Page): Promise<"light" | "dark"> {
  return page.evaluate(() => {
    const html = document.documentElement;
    return html.classList.contains("dark") ? "dark" : "light";
  });
}

/**
 * Toggles theme if toggle button exists
 */
export async function toggleTheme(page: Page) {
  // Look for theme toggle button
  const themeButton = page
    .locator('button[aria-label*="theme" i], button[title*="theme" i]')
    .first();
  if (await themeButton.isVisible().catch(() => false)) {
    await themeButton.click();
  }
}

/**
 * Gets sidebar width
 */
export async function getSidebarWidth(page: Page): Promise<number> {
  const sidebar = page.locator("[data-sidebar], aside, .sidebar").first();
  const box = await sidebar.boundingBox();
  return box?.width || 0;
}

/**
 * Resizes sidebar by dragging its edge
 */
export async function resizeSidebar(page: Page, deltaX: number) {
  // Find sidebar resize handle
  const resizeHandle = page
    .locator("[data-resize-handle], .resize-handle")
    .first();
  const box = await resizeHandle.boundingBox();
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      box.x + box.width / 2 + deltaX,
      box.y + box.height / 2,
    );
    await page.mouse.up();
  }
}

/**
 * Presses Cmd+S (or Ctrl+S) to save
 */
export async function saveFile(page: Page) {
  const isMac = await page.evaluate(() => navigator.platform.includes("Mac"));
  await page.keyboard.press(isMac ? "Meta+s" : "Control+s");
}

/**
 * Presses Cmd+Z (or Ctrl+Z) to undo
 */
export async function undo(page: Page) {
  const isMac = await page.evaluate(() => navigator.platform.includes("Mac"));
  await page.keyboard.press(isMac ? "Meta+z" : "Control+z");
}

/**
 * Presses Cmd+Shift+Z (or Ctrl+Shift+Z) to redo
 */
export async function redo(page: Page) {
  const isMac = await page.evaluate(() => navigator.platform.includes("Mac"));
  await page.keyboard.press(isMac ? "Meta+Shift+z" : "Control+Shift+z");
}
