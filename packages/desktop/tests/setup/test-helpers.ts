import { Page } from "@playwright/test";

/**
 * Test Helpers for Metrists E2E Tests
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
    const dbName = (window as any).__VITE_INDEXEDDB_NAME__ || "metrists-fs";
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
          store.put({
            path: file.path,
            content: file.content || "",
            type: file.type,
            size: file.type === "file" ? file.content.length : 0,
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
    // Wait for specific file to appear in tree
    await page.waitForSelector(`button:has-text("${fileName}")`, {
      timeout: 10000,
    });
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
export async function openFileInTree(page: Page, fileName: string) {
  // Wait for the file button to be present
  // Files have a specific structure: button > div > svg (FileText icon) + span (filename)
  const fileButton = page
    .locator(`button:has-text("${fileName}")`)
    .filter({
      has: page.locator("svg").first(), // Files have an svg icon
    })
    .first();

  await fileButton.waitFor({ timeout: 5000 });
  await fileButton.click();

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
    const dbName = (window as any).__VITE_INDEXEDDB_NAME__ || "metrists-fs";
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
    const dbName = (window as any).__VITE_INDEXEDDB_NAME__ || "metrists-fs";
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
  // Find the directory button - it won't be in a tab bar, just in the file tree
  // We can't easily distinguish tabs from file tree buttons, so we look for the FIRST match
  // which should be the file tree (tabs come after in DOM order  typically)
  const allButtons = page.locator(`button:has-text("${dirName}")`);
  const count = await allButtons.count();

  // If there's only one, use it. If multiple, use the first (file tree)
  const dirButton = count > 0 ? allButtons.first() : allButtons;

  // Check if it needs expanding by looking for ChevronRight icon (collapsed state)
  const isCollapsed =
    (await dirButton.locator("svg.lucide-chevron-right").count()) > 0;

  if (isCollapsed) {
    await dirButton.click();
    // Wait a bit for expansion animation
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
        () => (window as any).__VITE_INDEXEDDB_NAME__ || "metrists-fs",
      )) as string,
      path: filePath,
    },
  );
}
