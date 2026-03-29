# AI Agent Guidelines for Metrists

Metrists is a **markdown-first, local-first text editor** built with React, Tauri, and TanStack DB.

## Core Principles

### 1. Performance First

- **Perceived**: UI feels instant
- **Real**: File open, typing latency, sync speed
- **Not priority**: Initial load time
- **Use**: Virtualization, lazy loading, memoization, debouncing

**Critical ops**: File opening/switching, editor reactivity, TanStack Query loading, file tree rendering

### 2. Cross-Platform

Works on macOS, Linux, Windows (Tauri), and web browsers. **Always use platform adapters** - never platform-specific code in components.

## Architecture

### Three Storage Layers

**A. Project Files**

- Location: User directory on disk
- Contains: File content + project settings (text direction, project name, metadata)
- Access: TanStack DB collections (on-demand loading)

**B. URL/Route State** (React Router 7)

- `basePath` → Route param
- Open tabs, dockable layout, sidebar state, settings modal → Search params
- File paths → URL-encoded absolute paths
- Utilities: `src/utils/routing.ts`

**C. Application Settings**

- Location: Local storage (browser) / Tauri config plugin (desktop)
- Contains: Theme, window size, recent workspaces, shortcuts
- Sync: Automatic between browser and Tauri

### State Management: TanStack DB + Query

```typescript
// Define collection
const metadataCollection = createCollection(
  queryCollectionOptions({
    queryKey: ["file-metadata", workspaceId],
    queryFn: () => platformAdapter.readDirectory(workspaceId),
    queryClient,
    getKey: (item) => item.path,
    syncMode: "eager", // or "on-demand"
  }),
);

// Query in components
const { data } = useLiveQuery((q) =>
  q.from({ file: metadataCollection }).where(...).select()
);
```

**Two Collection Pattern:**

1. **Metadata Collection** (`eager`): path, type, size, modified, contentHash. Loads all files immediately for file tree.
2. **Content Collection** (`on-demand`): path, content, contentHash. Loads only when queried for open tabs.

**On-Demand Loading:**

```typescript
const contentCollection = createCollection(
  queryCollectionOptions({
    queryKey: ["file-content", workspaceId],
    queryFn: async (context) => {
      const parsed = parseLoadSubsetOptions(context.meta?.loadSubsetOptions);
      const requestedPaths = extractPathsFromFilters(parsed.filters);
      if (requestedPaths.length === 0) return [];
      const result = await platformAdapter.readFiles(requestedPaths);
      return result.succeeded.map(...);
    },
    syncMode: "on-demand",
  }),
);
```

**Key Principles:**

- Don't manually load data - `queryFn` handles it
- Use joins (`leftJoin`) to combine collections

### TanStack CLI Documentation

Use the TanStack CLI to query documentation:

```bash
# List add-ons
tanstack create --list-add-ons --framework React --json

# Get addon details
tanstack create --addon-details tanstack-query --framework React --json

# List libraries
tanstack libraries --json

# Search docs
tanstack search-docs "loaders" --library router --framework react --json

# Ecosystem
tanstack ecosystem --category auth --json
```

- `useLiveQuery` re-renders when data changes
- Mutations: `collection.insert/update/delete` (triggers handlers)
- Direct writes: `collection.utils.writeInsert/writeUpdate/writeDelete` (bypasses handlers)

### Platform Adapters

**Location:** `src/adapters/`

**Adapters:**

- `BrowserAdapter`: File System Access API
- `BrowserIndexedDBAdapter`: IndexedDB for testing
- `TauriAdapter`: Tauri native APIs

**Guardrails (High-Friction Changes):**

- Weight additions heavily - adds maintenance burden across all 3 adapters
- Must implement cleanly in **all 3 adapters**
- **All Tauri and Browser FS surfaces require unit tests**
- Adapters must behave identically - no platform-specific quirks
- Prefer composing existing methods over adding new ones
- Keep platform details internal - never expose outside adapter layer
- **When in doubt, discuss first**

**Usage:**

```typescript
import { platformAdapter } from "@/adapters";
const dirPath = await platformAdapter.pickDirectory("Select workspace");
```

**Never:** Import Tauri APIs directly, use `window.__TAURI__` checks, platform logic outside adapters

## Editor (Plate)

**Multi-Tab Architecture:** All tabs render simultaneously (hidden via `display: none`). Preserves cursor, scroll, undo/redo. ~5-10MB per tab.

```typescript
{fileDataWithContent.map((fileEntry) => (
  <div key={fileEntry.path} style={{ display: fileEntry.path === activeTabId ? 'block' : 'none' }}>
    <TextEditor file={fileEntry} />
  </div>
))}
```

## Testing (Playwright)

**Structure:** `tests/e2e/` with fixture-based organization

**Pattern:**

```typescript
test.beforeEach(async ({ page }) => {
  await setupTestDatabase(page, "test-name");
  await openWorkspace(page, "/workspace/test-path");
  await seedTestFiles(page, testFiles);
  await page.reload();
});
```

**Helpers:** `setupTestDatabase`, `seedTestFiles`, `openFileInTree`, `replaceEditorContent`, `getEditorContent`, `waitForAutoSave`, `getIndexedDBContent`

## Code Organization

```
src/
├── adapters/          # Platform abstraction
├── components/        # React components
│   ├── editor/        # Editor-specific
│   └── ui/            # shadcn/ui
├── hooks/             # React hooks
├── lib/               # Library configs
└── utils/             # Pure functions
```

**Hooks vs Utils:** Hook = React context/state/lifecycle. Util = Pure function, no React.

## Conventions

- TypeScript strictly, no `any`
- Functional components, hooks for state
- PascalCase components, camelCase hooks/utils
- File order: Imports → Types → Component

## Anti-Patterns

**Don't:**

- ❌ Import Tauri APIs directly
- ❌ Manually load TanStack DB collections
- ❌ Put ephemeral UI state in URL
- ❌ Add dependencies without asking
- ❌ Block UI thread
- ❌ Hard-code platform checks outside adapters

**Do:**

- ✅ Use platform adapters
- ✅ Trust TanStack Query auto-fetch
- ✅ Put navigation state in URL
- ✅ Use React state for UI-only state
- ✅ Virtualize large lists
- ✅ Keep platform logic in adapters

## Summary

1. **Performance**: Fast file operations, responsive UI
2. **Cross-platform**: Use adapters, never platform-specific code
3. **Storage**: Know what goes where (Project/URL/App)
4. **Local-first**: Trust TanStack Query, work offline
5. **Simple**: Don't over-engineer
