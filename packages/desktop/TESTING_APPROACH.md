# Testing Approach - Quick Reference

## How Database Isolation Works

### 1. Database Name Strategy (Automatic per Workspace!)

```typescript
// In browser-adapter.ts:
private getDBName(): string {
  // 1. Test override (highest priority)
  if ((window as any).__VITE_INDEXEDDB_NAME__) {
    return (window as any).__VITE_INDEXEDDB_NAME__;
  }

  // 2. Workspace-specific database (production)
  // Each workspace gets its own database automatically!
  if (this.currentWorkspace) {
    return `metrists-fs-${encodeURIComponent(this.currentWorkspace)}`;
  }

  // 3. Fallback
  return "metrists-fs";
}
```

**Production Benefits:**

- ✅ **Multiple workspaces**: Each workspace uses a separate IndexedDB database
- ✅ **No conflicts**: `/workspace/project-a` and `/workspace/project-b` never interfere
- ✅ **Automatic**: No manual configuration needed
- ✅ **Clean**: Browser storage neatly organized by workspace

**Examples:**

```typescript
// Workspace: /workspace/demo-content
// Database: metrists-fs-workspace%2Fdemo-content

// Workspace: /Users/john/projects/my-app
// Database: metrists-fs-Users%2Fjohn%2Fprojects%2Fmy-app

// Workspace: C:\Documents\notes
// Database: metrists-fs-C%3A%5CDocuments%5Cnotes
```

### 2. Test Setup Pattern (Pre-Seed Data)

```typescript
// tests/e2e/happy-path.spec.ts
test.beforeEach(async ({ page }) => {
  const dbName = "metrists-fs-test-happy-path";

  // Clear previous test data
  await clearIndexedDB(page, dbName);

  // Override database name BEFORE app loads
  await page.addInitScript((name) => {
    (window as any).__VITE_INDEXEDDB_NAME__ = name;
  }, dbName);

  // Pre-seed demo files using Playwright API
  await seedDemoData(page, dbName, {
    "/workspace/demo-content/README.md":
      "# Welcome\n\nThis is a demo workspace.",
    "/workspace/demo-content/docs/getting-started.md": "# Getting Started",
    "/workspace/demo-content/notes/2026-02-01.md": "# Daily Note",
    // Add exactly the files your test needs
  });

  // Navigate to app - data is already loaded!
  await page.goto("/workspace/demo-content");

  // Wait for UI to render
  await page.waitForSelector("text=README.md");
});
```

### 3. Seed Function (Helper)

```typescript
// tests/e2e/helpers/indexdb.ts
export async function seedDemoData(
  page: Page,
  dbName: string,
  files: Record<string, string>, // { path: content }
) {
  await page.evaluate(
    async ({ db, fileData }) => {
      const request = indexedDB.open(db, 1);

      await new Promise<void>((resolve, reject) => {
        request.onupgradeneeded = (event) => {
          const database = (event.target as IDBOpenDBRequest).result;
          if (!database.objectStoreNames.contains("files")) {
            database.createObjectStore("files", { keyPath: "path" });
          }
        };

        request.onsuccess = () => {
          const database = request.result;
          const tx = database.transaction("files", "readwrite");
          const store = tx.objectStore("files");

          // Insert all files
          for (const [path, content] of Object.entries(fileData)) {
            store.put({
              path,
              content,
              modifiedAt: new Date(),
              createdAt: new Date(),
            });
          }

          tx.oncomplete = () => {
            database.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };

        request.onerror = () => reject(request.error);
      });
    },
    { db: dbName, fileData: files },
  );
}
```

## Why This Approach?

### ✅ Advantages

1. **Parallel Execution**: Each test suite uses a different database name
2. **No Race Conditions**: Tests don't interfere with each other
3. **Explicit Data**: Each test clearly shows what data it needs
4. **Fast**: No waiting for app's async seeding logic
5. **Flexible**: Easy to customize data per test
6. **Clean Tests**: Don't test database creation unless that's what you're testing
7. **Production Isolation**: Each workspace gets its own database automatically! 🎉

### 🌟 Production Multi-Workspace Support

```typescript
// User opens different workspaces:
// /workspace/demo-content    → metrists-fs-workspace%2Fdemo-content
// /workspace/my-notes        → metrists-fs-workspace%2Fmy-notes
// /Users/john/projects/app   → metrists-fs-Users%2Fjohn%2Fprojects%2Fapp

// All completely isolated - no conflicts!
```

### ❌ Alternative (Not Used)

```typescript
// DON'T DO THIS - relies on app's seeding logic
test.beforeEach(async ({ page }) => {
  await page.goto("/workspace/demo-content");
  // Wait for app to seed demo data...
  await waitForDemoData(page, 8); // ❌ Slow, implicit, fragile
});
```

## Test Database Names

```typescript
// tests/e2e/setup/test-db.ts
export const TEST_DB_NAMES = {
  happyPath: "metrists-fs-test-happy-path",
  fileManagement: "metrists-fs-test-file-mgmt",
  contentPersistence: "metrists-fs-test-content",
};
```

## Production vs Testing

```bash
# Production - automatic workspace isolation
npm run dev

# Open /workspace/demo-content
# Uses: metrists-fs-workspace%2Fdemo-content

# Open /workspace/my-notes
# Uses: metrists-fs-workspace%2Fmy-notes

# Open /Users/john/documents
# Uses: metrists-fs-Users%2Fjohn%2Fdocuments

# Each workspace is completely isolated! ✅

# Tests - explicit database override
npm run test:e2e
# Suite 1 uses: metrists-fs-test-happy-path
# Suite 2 uses: metrists-fs-test-file-mgmt
# Suite 3 uses: metrists-fs-test-content
```

## Key Files

- `src/adapters/browser-adapter.ts` - Reads database name (test override or default)
- `tests/e2e/setup/test-db.ts` - Database name constants
- `tests/e2e/helpers/indexdb.ts` - Helper functions (seedDemoData, clearIndexedDB, etc)
- `tests/e2e/*.spec.ts` - Test suites

## Full Test Example

```typescript
import { test, expect } from "@playwright/test";
import { TEST_DB_NAMES } from "./setup/test-db";
import {
  seedDemoData,
  clearIndexedDB,
  getIndexedDBFile,
} from "./helpers/indexdb";

test.describe("Happy Path", () => {
  test.beforeEach(async ({ page }) => {
    await clearIndexedDB(page, TEST_DB_NAMES.happyPath);

    await page.addInitScript((name) => {
      (window as any).__VITE_INDEXEDDB_NAME__ = name;
    }, TEST_DB_NAMES.happyPath);

    await seedDemoData(page, TEST_DB_NAMES.happyPath, {
      "/workspace/demo-content/README.md": "# Welcome",
    });

    await page.goto("/workspace/demo-content");
    await page.waitForSelector("text=README.md");
  });

  test("edit and persist content", async ({ page }) => {
    await page.click("text=README.md");
    await page.locator(".editor").fill("# Edited Content");
    await page.waitForTimeout(600); // debounce

    const file = await getIndexedDBFile(
      page,
      TEST_DB_NAMES.happyPath,
      "/workspace/demo-content/README.md",
    );
    expect(file.content).toContain("Edited Content");

    await page.reload();
    await expect(page.locator(".editor")).toContainText("Edited Content");
  });
});
```

---

**Status**: Approach finalized ✅ | Ready for Phase 2 implementation
