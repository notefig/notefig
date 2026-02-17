# Playwright Testing Suite Implementation Plan

## Overview

This plan outlines the implementation of a comprehensive Playwright testing suite for Metrists with parallel execution support using isolated IndexedDB databases.

## 🎯 Key Design Decisions

### ✅ Pre-Seed Database with Playwright (Not App Logic)

**Decision**: Use Playwright's `page.evaluate()` to seed IndexedDB **before** navigating to the app.

**Why?**

- ✅ **Faster**: No waiting for app's async seeding logic
- ✅ **Explicit**: Tests show exactly what data they're working with
- ✅ **Isolated**: Tests don't depend on app's demo data logic
- ✅ **Flexible**: Easy to customize data per test
- ✅ **Clean**: Only test database creation when actually testing it

**How?**

```typescript
test.beforeEach(async ({ page }) => {
  // 1. Set database name override
  await page.addInitScript((dbName) => {
    (window as any).__VITE_INDEXEDDB_NAME__ = dbName;
  }, "metrists-fs-test-happy-path");

  // 2. Pre-seed data directly into IndexedDB
  await seedDemoData(page, "metrists-fs-test-happy-path", {
    "/workspace/demo-content/README.md": "# Welcome",
    // ... more files
  });

  // 3. Navigate - data already exists!
  await page.goto("/workspace/demo-content");
});
```

## 🎯 Key Objectives

1. **Parallel Execution**: Each test suite uses its own IndexedDB database
2. **Dynamic Database Names**: Configure DB names via environment variables
3. **Consolidated Test Suites**: 3 focused suites covering critical paths
4. **Fast Execution**: ~50% faster via parallel test execution

---

## 📋 Implementation Phases

### Phase 1: Make IndexedDB Database Name Configurable ✅ COMPLETE

**Goal**: Enable dynamic database names for test isolation + automatic workspace isolation

**Files Modified**:

1. ✅ `src/adapters/browser-adapter.ts`
   - Changed from static `DB_NAME` to dynamic `getDBName()` method
   - Added `setWorkspace()` method to extract workspace from file paths
   - Database name now automatically derived from workspace path
   - Test override via `window.__VITE_INDEXEDDB_NAME__` has highest priority
   - Each file operation automatically sets the workspace context

**How It Works:**

**Production (Automatic Workspace Isolation):**

```typescript
// User opens: /workspace/demo-content
// Adapter detects workspace from path
// Database: metrists-fs-workspace%2Fdemo-content

// User opens: /workspace/my-notes
// Different workspace = different database
// Database: metrists-fs-workspace%2Fmy-notes

// ✅ Complete isolation between workspaces!
```

**Testing (Explicit Override):**

```typescript
// Tests use page.addInitScript to override
await page.addInitScript((name) => {
  (window as any).__VITE_INDEXEDDB_NAME__ = name;
}, "metrists-fs-test-happy-path");

// Database: metrists-fs-test-happy-path (ignores workspace)
```

**Why This Approach?**

- ✅ **Multi-workspace support**: Users can have multiple workspaces without conflicts
- ✅ **Automatic isolation**: No manual configuration needed
- ✅ **Clean browser storage**: Each workspace organized separately
- ✅ **Test compatibility**: Tests can still override database name
- ✅ **No breaking changes**: Existing functionality preserved

**Acceptance Criteria**:

- ✅ Each workspace path gets its own IndexedDB database
- ✅ Database name automatically derived from first path component
- ✅ Test override via `window.__VITE_INDEXEDDB_NAME__` still works
- ✅ Database connection resets when workspace changes
- ✅ All file operations extract and set workspace context

---

### Phase 2: Set Up Playwright Infrastructure

**Goal**: Install Playwright and create test structure

**Tasks**:

1. Install dependencies:

   ```bash
   npm install -D @playwright/test
   npx playwright install chromium
   ```

2. Create test directory structure:

   ```
   tests/
   ├── e2e/
   │   ├── setup/
   │   │   ├── test-db.ts
   │   │   └── clean-db.ts
   │   ├── helpers/
   │   │   ├── indexdb.ts
   │   │   ├── navigation.ts
   │   │   └── assertions.ts
   │   └── .gitkeep
   └── playwright.config.ts
   ```

3. Create `playwright.config.ts` with:

   - Base URL: `http://localhost:1420`
   - Full parallel execution enabled
   - 3 workers for 3 test suites
   - Web server auto-start configuration
   - Screenshot on failure
   - HTML reporter

4. Add npm scripts to `package.json`:
   ```json
   {
     "test:e2e": "playwright test",
     "test:e2e:ui": "playwright test --ui",
     "test:e2e:debug": "playwright test --debug"
   }
   ```

**Acceptance Criteria**:

- ✅ Playwright installed and configured
- ✅ Test directory structure created
- ✅ Config file enables parallel execution
- ✅ Dev server starts automatically for tests

---

### Phase 3: Create Test Helpers

**Goal**: Build reusable utilities for test suites

**Files to Create**:

1. `tests/e2e/setup/test-db.ts`

   - Export database names for each suite
   - Export function to get environment variables for test context

2. `tests/e2e/setup/clean-db.ts`

   - Database cleanup utilities
   - Pre-test and post-test cleanup functions

3. `tests/e2e/helpers/indexdb.ts`

   - `getIndexedDBFiles(page, dbName)` - Query all files
   - `getIndexedDBFile(page, dbName, path)` - Query single file
   - `clearIndexedDB(page, dbName)` - Delete database
   - `seedDemoData(page, dbName, files)` - **Pre-seed data before navigation**
   - `waitForFileContent(page, dbName, path, expectedContent)` - Wait for save
   - `countFiles(page, dbName)` - Count total files in database

4. `tests/e2e/helpers/navigation.ts`

   - `navigateToWorkspace(page, dbName, basePath?)` - Navigate with DB env
   - `openFile(page, filePath)` - Click file in tree
   - `switchTab(page, fileName)` - Switch active tab
   - `closeTab(page, fileName)` - Close specific tab

5. `tests/e2e/helpers/assertions.ts`
   - `expectTabOpen(page, fileName)` - Assert tab exists
   - `expectTabActive(page, fileName)` - Assert tab is active
   - `expectFileInUrl(page, filePath)` - Assert file in search params
   - `expectDirectoryExpanded(page, dirName)` - Assert dir is expanded

**Acceptance Criteria**:

- ✅ All helper functions created and typed
- ✅ Helpers use page.evaluate for IndexedDB access
- ✅ Navigation helpers handle URL encoding
- ✅ Assertions provide clear error messages

---

### Phase 4: Suite 1 - Happy Path Tests

**Database**: `metrists-fs-test-happy-path`

**File**: `tests/e2e/happy-path.spec.ts`

**Test Cases**:

1. **Complete User Flow**

   - Navigate to workspace URL
   - Verify demo data auto-seeds (8 files)
   - Expand docs directory
   - Open README.md
   - Edit content (add "# Test Heading")
   - Wait for save (500ms debounce)
   - Refresh page
   - Verify edits persisted
   - Verify file still open

2. **Multi-File Workflow**
   - Open 3 files: README.md, docs/getting-started.md, notes/2026-02-01.md
   - Switch between tabs
   - Edit each file with unique content
   - Verify all 3 URLs in search params
   - Verify all edits persist after refresh

**Acceptance Criteria**:

- ✅ Tests pass with isolated database
- ✅ Demo data seeds correctly
- ✅ Content edits persist across refresh
- ✅ Multiple files can be edited simultaneously

---

### Phase 5: Suite 2 - File Management Tests

**Database**: `metrists-fs-test-file-mgmt`

**File**: `tests/e2e/file-management.spec.ts`

**Test Cases**:

1. **Directory Expansion & File Browsing**

   - Verify all 3 directories visible (docs, notes, projects)
   - Verify directories show expand arrows
   - Expand/collapse directories
   - Verify clicking directory does NOT create tab
   - Verify clicking file DOES create tab

2. **Multi-Tab Management**

   - Open 5 files in different directories
   - Verify all 5 tabs exist in UI and URL
   - Switch active tabs
   - Close tab
   - Refresh and verify tabs restore

3. **File Editing with Tab Switching**

   - Open README.md and docs/features.md
   - Edit both files
   - Switch between tabs
   - Verify edits persist when switching (tests all-tabs-rendered architecture)
   - Verify IndexedDB has correct content for both

4. **Directory Inference**
   - Query IndexedDB directly
   - Verify only file entries exist (no directory entries)
   - Verify directories inferred from file paths
   - Verify expand/collapse doesn't write to DB

**Acceptance Criteria**:

- ✅ File tree navigation works correctly
- ✅ Multi-tab state managed properly
- ✅ Tab switching preserves editor state
- ✅ Directory inference works without DB entries

---

### Phase 6: Suite 3 - Content & Persistence Tests

**Database**: `metrists-fs-test-content`

**File**: `tests/e2e/content-persistence.spec.ts`

**Test Cases**:

1. **Create Markdown Document with Multiple Elements**

   - Type complete markdown document (headings, lists, code blocks, links)
   - Wait for debounce
   - Verify exact markdown in IndexedDB
   - Verify content hash updated

2. **Complex Content Persistence Across Sessions**

   - Create document with H1, list, code block
   - Get content hash
   - Refresh page
   - Verify content restored exactly
   - Edit document
   - Verify content hash changed
   - Close and reopen file
   - Verify edits persisted

3. **Multi-File Content Verification**

   - Edit 3 files with distinct markdown
   - Verify each file has correct content in IndexedDB
   - Verify content hashes are different
   - Refresh and verify all content correct

4. **Real-Time IndexedDB Sync**
   - Type character by character
   - Verify debounced saves to IndexedDB
   - Add code block with syntax highlighting
   - Verify complete markdown syntax in DB

**Acceptance Criteria**:

- ✅ Markdown content saves correctly
- ✅ Content hashes update on changes
- ✅ Content persists across sessions
- ✅ Multiple files maintain distinct content

---

### Phase 7: CI/CD Integration (Optional)

**Goal**: Automate test execution in GitHub Actions

**Tasks**:

1. Create `.github/workflows/e2e.yml`
2. Configure workflow to:
   - Install dependencies
   - Install Playwright browsers
   - Run tests in parallel
   - Upload test artifacts on failure
   - Generate and upload HTML report

**Acceptance Criteria**:

- ✅ Tests run automatically on PR
- ✅ Test results visible in GitHub UI
- ✅ Failed tests provide screenshots/traces

---

## 🗄️ Database Strategy

### Per-Suite Database Names

```typescript
export const TEST_DB_NAMES = {
  happyPath: "metrists-fs-test-happy-path",
  fileManagement: "metrists-fs-test-file-mgmt",
  contentPersistence: "metrists-fs-test-content",
};
```

### Database Setup Pattern (Pre-Seed with Playwright)

```typescript
// Set up database BEFORE navigating to the page
test.beforeEach(async ({ page }) => {
  const dbName = TEST_DB_NAMES.happyPath;

  // 1. Clear previous database
  await clearIndexedDB(page, dbName);

  // 2. Set environment variable for this test
  await page.addInitScript((dbName) => {
    // Override the environment variable before app loads
    (window as any).__VITE_INDEXEDDB_NAME__ = dbName;
  }, dbName);

  // 3. Navigate to a blank page to initialize the override
  await page.goto("about:blank");

  // 4. Pre-seed demo data directly into IndexedDB
  await seedDemoData(page, dbName, {
    "/workspace/demo-content/README.md": "# Demo Workspace\n\nWelcome!",
    "/workspace/demo-content/docs/getting-started.md":
      "# Getting Started\n\nLet's begin.",
    "/workspace/demo-content/docs/features.md":
      "# Features\n\n- Feature 1\n- Feature 2",
    "/workspace/demo-content/notes/2026-02-01.md":
      "# Daily Note\n\nToday I learned...",
    // ... more files
  });

  // 5. Navigate to workspace - data is already there!
  await page.goto("/workspace/demo-content");

  // 6. Wait for UI to render (file tree, etc)
  await page.waitForSelector('[data-testid="file-tree"]');
});
```

**Key Advantages:**

- ✅ No reliance on application's demo data seeding logic
- ✅ Tests are self-contained and explicit about data
- ✅ Faster test execution (no waiting for async seeding)
- ✅ Easier to customize data per test
- ✅ Tests database creation only when actually testing it

---

## 📊 Expected Performance

### Sequential Execution (Before)

- Suite 1: 2 tests × 10s = 20s
- Suite 2: 4 tests × 8s = 32s
- Suite 3: 4 tests × 12s = 48s
- **Total: ~100s**

### Parallel Execution (After)

- All 3 suites run simultaneously
- **Total: ~48s (longest suite)**
- **50% faster! 🚀**

---

## 🎯 Success Criteria

### Overall Goals

- ✅ All 10 test cases pass consistently
- ✅ Tests run in parallel without conflicts
- ✅ Each suite uses isolated database
- ✅ No flaky tests (>95% reliability)
- ✅ Total execution time < 60s
- ✅ Clear error messages on failures
- ✅ Screenshots captured on failures

### Code Quality

- ✅ TypeScript strict mode
- ✅ No any types
- ✅ Reusable helper functions
- ✅ Clear test descriptions
- ✅ Proper async/await handling
- ✅ No hardcoded timeouts (use waitFor functions)

---

## 📝 Notes

### Architecture Decisions

1. **Environment Variable Approach**: Chosen over query parameters for cleaner URLs and better isolation
2. **All-Tabs-Rendered**: Tests leverage existing architecture where all tabs are rendered simultaneously
3. **IndexedDB Direct Access**: Tests use `page.evaluate()` to query IndexedDB directly for verification
4. **Demo Data Seeding**: Tests rely on existing demo data seeding logic

### Future Enhancements

- Add performance benchmarks (file open time, typing latency)
- Add accessibility tests (keyboard navigation, screen reader)
- Add visual regression tests (screenshot comparison)
- Add mobile viewport tests
- Add cross-browser tests (Firefox, Safari)

---

## 🚀 Getting Started

### Phase 1 Implementation (Current)

```bash
# No installation needed - modifying existing code
# Files being modified:
# - src/utils/indexdb-storage.ts
# - src/adapters/browser-adapter.ts
# - vite.config.ts
```

### Phase 2+ Implementation

```bash
# Install Playwright
npm install -D @playwright/test
npx playwright install chromium

# Run tests
npm run test:e2e

# Run tests with UI
npm run test:e2e:ui

# Debug tests
npm run test:e2e:debug
```

---

**Status**: Phase 1 complete ✅ | Phase 2 ready to start
**Last Updated**: 2026-02-16
**Completed By**: AI Assistant
