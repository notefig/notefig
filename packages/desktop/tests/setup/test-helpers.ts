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
 */
export async function waitForFileTree(page: Page) {
  // Wait for the workspace to load by checking for either:
  // 1. File buttons (if workspace has files)
  // 2. The "New file" button (if workspace is empty)
  await page.waitForSelector('button:has-text("New file")', {
    timeout: 10000,
  });
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
 */
export async function openFileInTree(page: Page, fileName: string) {
  // Look for a button containing the file name
  await page.click(`button:has-text("${fileName}")`);
}

/**
 * Gets the content of the currently active editor
 */
export async function getEditorContent(page: Page): Promise<string> {
  return page.evaluate(() => {
    const editor = document.querySelector('[data-plate-editor="true"]');
    return editor?.textContent || "";
  });
}

/**
 * Types text into the active editor
 */
export async function typeInEditor(page: Page, text: string) {
  const editor = page.locator('[data-plate-editor="true"]');
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
