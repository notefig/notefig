# File Watcher and E2E Testing Documentation

## Overview

This document describes the file watching system and E2E test architecture for Metrists, including test coverage requirements and implementation patterns.

## Architecture

### File Watcher System

Metrists has two file watching implementations:

1. **Browser File Watcher** (`src/adapters/browser-file-watcher.ts`)

   - Polling-based watching for browser File System Access API
   - Handles both metadata changes (file creation/deletion) and content changes
   - App write filtering to prevent feedback loops

2. **Rust File Watcher** (`src-tauri/src/file_watcher.rs`)
   - Native file system watching using `notify` crate
   - Debounced events with configurable debounce intervals
   - Handles atomic writes (common in Chrome's File System Access API)

### Event Types

```typescript
// Metadata changes - file/directory lifecycle
interface MetadataChange {
  type: "created" | "deleted" | "renamed";
  path: string;
  oldPath?: string;
  isDirectory: boolean;
}

// Content changes - file modifications
interface ContentChange {
  path: string;
  content: string;
  contentHash: string;
}
```

---

## Browser File Watcher Tests

### Test Coverage Requirements

#### Core Functionality (15 tests)

```typescript
describe("BrowserFileWatcher", () => {
  // Initialization
  describe("constructor", () => {
    it("should initialize with required dependencies");
    it("should create empty event listener set");
    it("should initialize with empty app writes array");
  });

  // Event Listeners
  describe("addEventListener", () => {
    it("should add callback to listeners");
    it("should return unsubscribe function");
    it("should allow multiple listeners");
  });

  describe("removeEventListener", () => {
    it("should remove callback from listeners");
    it("should handle removing non-existent listener");
  });

  // App Write Tracking
  describe("registerAppWrite", () => {
    it("should add app write to tracking");
    it("should garbage collect old writes (>10s TTL)");
    it("should allow multiple writes for same path");
  });

  describe("consumeAppWrite", () => {
    it("should return true and remove matching write");
    it("should return false for non-matching write");
    it("should garbage collect while consuming");
    it("should match by both path and hash");
  });
});
```

#### Metadata Watching (12 tests)

```typescript
describe("Metadata Watching", () => {
  describe("startWatchingMetadata", () => {
    it("should create snapshot of current state");
    it("should start polling interval (5s)");
    it("should handle multiple directories");
    it("should stop existing watcher with same ID");
    it("should emit fs-metadata-changed event on changes");
  });

  describe("takeMetadataSnapshot", () => {
    it("should recursively collect all files and directories");
    it("should handle read errors gracefully");
    it("should include timestamps in snapshot");
    it("should handle empty directories");
  });

  describe("diffMetadataSnapshots", () => {
    it("should detect created files");
    it("should detect deleted files");
    it("should detect created directories");
    it("should detect deleted directories");
    it("should return empty array when no changes");
    it("should handle multiple simultaneous changes");
  });

  describe("stopWatching", () => {
    it("should clear metadata polling interval");
    it("should remove watcher from map");
    it("should handle stopping non-existent watcher");
  });
});
```

#### Content Watching (14 tests)

```typescript
describe("Content Watching", () => {
  describe("startWatchingContent", () => {
    it("should create new watcher for new ID");
    it("should reconcile paths for existing watcher");
    it("should add new paths to snapshot");
    it("should remove paths no longer watched");
    it("should start polling interval (3s)");
  });

  describe("takeContentSnapshot", () => {
    it("should read file contents and compute hashes");
    it("should handle empty path list");
    it("should skip files that fail to read");
    it("should include timestamps");
  });

  describe("pollContentChanges", () => {
    it("should detect content changes by hash");
    it("should filter out app writes");
    it("should update snapshot after detecting change");
    it("should emit fs-content-changed event");
    it("should handle concurrent file modifications");
    it("should update snapshot for app writes without emitting");
  });

  describe("stopWatching", () => {
    it("should clear content polling interval");
    it("should handle content watcher independently of metadata");
  });
});
```

#### Lifecycle Management (6 tests)

```typescript
describe("Lifecycle", () => {
  describe("dispose", () => {
    it("should stop all metadata watchers");
    it("should stop all content watchers");
    it("should clear all event listeners");
    it("should clear app writes");
  });

  describe("polling intervals", () => {
    it("should use 5s interval for metadata");
    it("should use 3s interval for content");
  });
});
```

**Total: 47 tests for BrowserFileWatcher**

---

## Rust File Watcher Tests

### Test Coverage Requirements

#### Unit Tests in `file_watcher.rs`

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;
    use std::time::Duration;
    use tokio::time::sleep;

    // Event Processing Tests (8 tests)
    #[tokio::test]
    async fn test_process_create_file_event() {
        // Verify file creation emits metadata change
    }

    #[tokio::test]
    async fn test_process_create_directory_event() {
        // Verify directory creation emits metadata change
        // Verify children are also emitted
    }

    #[tokio::test]
    async fn test_process_delete_file_event() {
        // Verify file deletion emits metadata change
    }

    #[tokio::test]
    async fn test_process_delete_directory_event() {
        // Verify directory deletion emits metadata change
    }

    #[tokio::test]
    async fn test_process_modify_event() {
        // Verify content changes emit content change event
    }

    #[tokio::test]
    async fn test_process_rename_event() {
        // Verify rename emits metadata change with old_path
    }

    #[tokio::test]
    async fn test_process_atomic_write_event() {
        // Verify Name(Any) events are handled as content changes
    }

    #[tokio::test]
    async fn test_app_write_filtering() {
        // Verify app writes are not re-emitted as external changes
    }

    // Path Filtering Tests (4 tests)
    #[tokio::test]
    fn test_should_filter_hidden_paths() {
        // Verify .git, .vscode, etc. are filtered
    }

    #[tokio::test]
    fn test_should_filter_tmp_files() {
        // Verify .tmp files are filtered
    }

    #[tokio::test]
    fn test_should_not_filter_normal_paths() {
        // Verify regular files pass through
    }

    #[tokio::test]
    fn test_should_filter_nested_hidden_paths() {
        // Verify src/.hidden/file.txt is filtered
    }

    // Hash Computation Tests (3 tests)
    #[tokio::test]
    fn test_compute_content_hash() {
        // Verify MD5 hash is computed correctly
    }

    #[tokio::test]
    fn test_hash_determinism() {
        // Verify same content produces same hash
    }

    #[tokio::test]
    fn test_hash_uniqueness() {
        // Verify different content produces different hash
    }

    // Watcher Lifecycle Tests (6 tests)
    #[tokio::test]
    async fn test_start_watching_metadata() {
        // Verify watcher is created and stored
    }

    #[tokio::test]
    async fn test_start_watching_content() {
        // Verify watcher reconciles paths correctly
    }

    #[tokio::test]
    async fn test_stop_watching() {
        // Verify watcher is removed
    }

    #[tokio::test]
    async fn test_multiple_watchers() {
        // Verify multiple watch IDs work independently
    }

    #[tokio::test]
    async fn test_reconcile_add_paths() {
        // Verify new paths are added to watcher
    }

    #[tokio::test]
    async fn test_reconcile_remove_paths() {
        // Verify old paths are unwatched
    }

    // Directory Collection Tests (4 tests)
    #[tokio::test]
    async fn test_collect_directory_paths() {
        // Verify recursive path collection
    }

    #[tokio::test]
    async fn test_collect_handles_errors() {
        // Verify read errors don't crash collection
    }

    #[tokio::test]
    async fn test_collect_filters_hidden() {
        // Verify hidden files are excluded from collection
    }

    #[tokio::test]
    async fn test_collect_empty_directory() {
        // Verify empty directories work correctly
    }
}
```

**Total: 25 tests for Rust File Watcher**

---

## E2E Test Architecture

### Test Structure

```
tests/
├── e2e/
│   ├── file-watcher.spec.ts           # File watching E2E tests
│   ├── file-watcher.fixture.ts
│   ├── workspace-navigation.spec.ts   # Existing tests
│   ├── content-persistence.spec.ts    # Existing tests
│   └── ...
├── setup/
│   ├── test-helpers.ts               # Shared test utilities
│   └── test-data.ts                  # Shared test data
└── playwright.config.ts
```

### Fixture Pattern

Each test file has a corresponding `.fixture.ts` file:

```typescript
// tests/e2e/file-watcher.fixture.ts
export const fileWatcherFixture = {
  workspacePath: "/workspace/file-watcher-test",
  files: [
    {
      path: "/workspace/file-watcher-test/watched.md",
      content: "# Initial content",
      type: "file" as const,
    },
    {
      path: "/workspace/file-watcher-test/subdir",
      content: "",
      type: "directory" as const,
    },
  ],
};
```

### Helper Functions

```typescript
// File watcher specific helpers
export async function simulateExternalFileChange(
  page: Page,
  filePath: string,
  newContent: string,
) {
  // Direct IndexedDB manipulation to simulate external change
}

export async function waitForWatcherEvent(
  page: Page,
  eventType: "metadata" | "content",
  timeout: number = 5000,
) {
  // Wait for fs-metadata-changed or fs-content-changed event
}

export async function verifyFileWatcherActive(
  page: Page,
  filePath: string,
): Promise<boolean> {
  // Check if file is being watched
}
```

---

## E2E Test Scenarios

### File Watcher Tests

#### Metadata Watching (6 tests)

```typescript
describe("File Watcher - Metadata", () => {
  test("Detects external file creation", async ({ page }) => {
    // Setup workspace
    // Start watching
    // Simulate external file creation
    // Verify fs-metadata-changed event with created type
  });

  test("Detects external file deletion", async ({ page }) => {
    // Verify deleted event emitted
  });

  test("Detects external directory creation", async ({ page }) => {
    // Verify directory and children emitted as created
  });

  test("Detects external directory deletion", async ({ page }) => {
    // Verify directory deleted event emitted
  });

  test("Detects file rename", async ({ page }) => {
    // Verify renamed event with old_path
  });

  test("Detects directory rename with children", async ({ page }) => {
    // Verify parent and all children emitted with renamed type
  });
});
```

#### Content Watching (5 tests)

```typescript
describe("File Watcher - Content", () => {
  test("Detects external content changes", async ({ page }) => {
    // Watch file
    // Modify content externally
    // Verify fs-content-changed event
    // Verify content in event payload
  });

  test("Filters out own app writes", async ({ page }) => {
    // Edit file in editor
    // Wait for save
    // Verify no content-changed event for own changes
  });

  test("Handles concurrent external modifications", async ({ page }) => {
    // Multiple external changes in quick succession
    // Verify all changes detected
  });

  test("Updates TanStack DB on external change", async ({ page }) => {
    // Watch file, modify externally
    // Verify collection is updated with new content
  });

  test("Shows conflict indicator for external changes", async ({ page }) => {
    // Edit file locally (unsaved)
    // Modify externally
    // Verify conflict UI appears
  });
});
```

#### Performance & Edge Cases (4 tests)

```typescript
describe("File Watcher - Performance", () => {
  test("Handles rapid file operations", async ({ page }) => {
    // Create/delete/modify files rapidly
    // Verify events debounced correctly
  });

  test("Ignores hidden files and directories", async ({ page }) => {
    // Create .git, .vscode directories
    // Create .DS_Store file
    // Verify no events emitted
  });

  test("Handles large directory trees", async ({ page }) => {
    // 1000+ files
    // Verify watcher starts without timeout
    // Verify changes detected correctly
  });

  test("Recovers from watcher errors", async ({ page }) => {
    // Simulate permission error
    // Verify graceful degradation
    // Verify retry or fallback behavior
  });
});
```

**Total: 15 E2E tests for File Watcher**

### Additional E2E Test Suites

#### File Drag and Drop (4 tests)

```typescript
describe("File Drag and Drop", () => {
  test("Drag file into workspace", async ({ page }) => {
    // Drag external file into file tree
    // Verify file appears in tree
    // Verify content loaded
  });

  test("Drag file to different folder", async ({ page }) => {
    // Drag file from one folder to another
    // Verify path updated in tree
    // Verify file opens with new path
  });

  test("Drag multiple files", async ({ page }) => {
    // Select multiple files
    // Drag to new location
    // Verify all files moved
  });

  test("Cancel drag with Escape", async ({ page }) => {
    // Start drag
    // Press Escape
    // Verify no changes
  });
});
```

#### Tab Management (6 tests)

```typescript
describe("Tab Management", () => {
  test("Open multiple files creates tabs", async ({ page }) => {
    // Open 3 files
    // Verify all tabs visible
    // Verify correct tab active
  });

  test("Drag tabs to reorder", async ({ page }) => {
    // Drag tab to new position
    // Verify order updated
    // Verify persistence after reload
  });

  test("Close tab with keyboard shortcut", async ({ page }) => {
    // Open file
    // Press Cmd+W
    // Verify tab closed
  });

  test("Close all other tabs", async ({ page }) => {
    // Open 3 files
    // Right-click tab, select "Close Others"
    // Verify only active tab remains
  });

  test("Close tabs to the right", async ({ page }) => {
    // Open 4 files
    // Right-click second tab, select "Close to Right"
    // Verify correct tabs closed
  });

  test("Restore last closed tab", async ({ page }) => {
    // Close tab
    // Use Cmd+Shift+T
    // Verify tab restored with content
  });
});
```

#### Auto-Save (5 tests)

```typescript
describe("Auto-Save", () => {
  test("Auto-saves after debounce", async ({ page }) => {
    // Type content
    // Wait for debounce
    // Verify saved to storage
  });

  test("Manual save bypasses debounce", async ({ page }) => {
    // Type content
    // Press Cmd+S immediately
    // Verify saved without waiting
  });

  test("Shows save indicator during save", async ({ page }) => {
    // Edit file
    // Verify "Saving..." indicator appears
    // Verify changes to "Saved"
  });

  test("Handles save errors gracefully", async ({ page }) => {
    // Simulate save error
    // Verify error message shown
    // Verify retry option available
  });

  test("Preserves save state across reloads", async ({ page }) => {
    // Save file
    // Reload page
    // Verify save state restored (no unsaved indicator)
  });
});
```

#### Block Operations (4 tests)

```typescript
describe("Block Operations", () => {
  test("Select multiple blocks with Shift+Click", async ({ page }) => {
    // Click first block
    // Shift+click third block
    // Verify blocks 1-3 selected
  });

  test("Drag selected blocks to new position", async ({ page }) => {
    // Select multiple blocks
    // Drag to new location
    // Verify reordering
  });

  test("Copy and paste blocks", async ({ page }) => {
    // Select blocks
    // Copy with Cmd+C
    // Paste with Cmd+V
    // Verify duplicates created
  });

  test("Delete multiple selected blocks", async ({ page }) => {
    // Select blocks
    // Press Delete
    // Verify blocks removed
  });
});
```

#### Settings Persistence (4 tests)

```typescript
describe("Settings Persistence", () => {
  test("Persists window size", async ({ page }) => {
    // Resize window
    // Close and reopen app
    // Verify size restored
  });

  test("Persists sidebar width", async ({ page }) => {
    // Resize sidebar
    // Reload page
    // Verify width restored
  });

  test("Persists theme preference", async ({ page }) => {
    // Change theme
    // Reload page
    // Verify theme restored
  });

  test("Persists recent workspaces", async ({ page }) => {
    // Open workspace
    // Check recent workspaces list
    // Verify workspace appears
  });
});
```

**Total Additional E2E Tests: 23 tests**

---

## Test Patterns & Best Practices

### Isolation

```typescript
// Each test gets unique database
test.beforeEach(async ({ page }) => {
  await setupTestDatabase(page, "unique-test-name");
  await openWorkspace(page, "/workspace/test");
  await seedTestFiles(page, fixture.files);
  await page.reload();
});

test.afterEach(async ({ page }) => {
  await clearTestDatabase(page);
});
```

### Waiting Strategies

```typescript
// Prefer explicit waits over arbitrary timeouts
await page.waitForSelector('[data-testid="file-tree"]', {
  timeout: 10000,
});

// For debounced operations
await waitForAutoSave(page, 500);

// For async operations with known conditions
await waitForWatcherEvent(page, "content", 5000);
```

### Assertion Patterns

```typescript
// Test one behavior per assertion
test("detects file creation", async ({ page }) => {
  const eventPromise = waitForEvent(page, "fs-metadata-changed");

  // Trigger change
  await simulateFileCreation(page, "new-file.md");

  // Assert specific behavior
  const event = await eventPromise;
  expect(event.changes).toHaveLength(1);
  expect(event.changes[0].type).toBe("created");
  expect(event.changes[0].path).toContain("new-file.md");
});
```

### Mocking External Changes

```typescript
// For browser adapter, manipulate IndexedDB directly
async function simulateExternalChange(
  page: Page,
  filePath: string,
  content: string,
) {
  await page.evaluate(
    async ({ path, data }) => {
      // Bypass file watcher by directly writing to storage
      const db = await openDB("metrists-fs");
      await db.put("files", {
        path,
        content: data,
        modified: Date.now(),
      });
    },
    { path: filePath, data: content },
  );
}
```

---

## Test Commands

```bash
# Run all tests
npm run test:all

# TypeScript unit tests only
npm run test:unit

# Rust tests only
npm run test:rust

# E2E tests only
npm run test:e2e

# Run specific E2E test file
npm run test:e2e -- tests/e2e/file-watcher.spec.ts

# Run with UI for debugging
npm run test:e2e -- --ui

# Run in headed mode (see browser)
npm run test:e2e -- --headed
```

---

## Summary

### Test Count Summary

| Category                       | Planned | Implemented | Status      |
| ------------------------------ | ------- | ----------- | ----------- |
| BrowserFileWatcher Unit Tests  | 47      | 0           | Not Started |
| Rust File Watcher Unit Tests   | 25      | 0           | Not Started |
| File Watcher E2E Tests         | 15      | 0           | Not Started |
| File Drag & Drop E2E Tests     | 4       | 0           | Not Started |
| Tab Management E2E Tests       | 6       | 0           | Not Started |
| Auto-Save E2E Tests            | 5       | 0           | Not Started |
| Block Operations E2E Tests     | 4       | 0           | Not Started |
| Settings Persistence E2E Tests | 4       | 0           | Not Started |
| **Total**                      | **110** | **0**       | **Planned** |

### Priority Order

1. **High Priority**: BrowserFileWatcher unit tests (47 tests)
2. **High Priority**: Rust file watcher unit tests (25 tests)
3. **Medium Priority**: File watcher E2E tests (15 tests)
4. **Medium Priority**: Auto-save E2E tests (5 tests)
5. **Low Priority**: Tab management, drag & drop, blocks, settings (18 tests)

### Implementation Notes

- BrowserFileWatcher tests should mock `readDirectory`, `readFiles`, and `getMetadata`
- Rust tests should use `tempfile::TempDir` for isolation
- E2E tests should use unique database names for isolation
- File watcher tests need to account for polling intervals (5s metadata, 3s content)
- Consider using fake timers for unit tests to avoid real waits
