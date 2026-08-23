# AI Agent Guidelines for Metrists

Metrists is a **markdown-first, local-first text editor** built with React, Tauri, and TanStack DB.

## Core Principles

### 1. Performance First|

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

**Multi-Tab Architecture:** All tabs render simultaneously (hidden via `display: none`). Preserves cursor, scroll, undo/redo. \~5-10MB per tab.

```typescript
{fileDataWithContent.map((fileEntry) => (
  <div key={fileEntry.path} style={{ display: fileEntry.path === activeTabId ? 'block' : 'none' }}>
    <TextEditor file={fileEntry} /></div>
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

## App Icons (macOS)

### The Problem

macOS app icons have strict design requirements. The icon must follow Apple's Human Interface Guidelines to render correctly across:

- Dock
- Finder
- Spotlight
- Launchpad
- System Settings

### macOS Tahoe (macOS 26) Changes

Apple introduced new icon rendering with **Liquid Glass** effects in macOS 26. While `.icns` files still work, the system applies stricter masking and scaling. Icons that don't follow the proper grid appear too small or have ugly gray borders.

### Icon Specifications

**Content Ratio:** The actual icon content (logo/artwork) should occupy **\~83%** of the total canvas. This leaves transparent padding around the edges for macOS to apply its own rounded corners, shadows, and glass effects.

**Corner Radius:** macOS app icons use a corner radius of approximately **22.37%** of the canvas width. For a 1024×1024 icon, this means:

- Corner radius: \~229px
- The icon should have rounded corners built-in

**Example for 1024×1024:**

- Canvas: 1024×1024
- Content size: \~849×849 (83%)
- Corner radius: \~229px
- Padding: \~87px on each side

### Common Mistakes

1. **Solid background filling 100%** — macOS will not apply its glass effects properly
2. **Logo too small** (&lt; 80%) — icon appears tiny in the grid
3. **Logo too large** (&gt; 90%) — edges get clipped by the system mask
4. **Sharp corners** — macOS expects pre-rounded icons
5. **Runtime hacks** — Using `setApplicationIconImage` only fixes the Dock, not Finder/Spotlight

### Implementation

**Tauri Configuration:**

```json
"icon": [
  "icons/32x32.png",
  "icons/64x64.png",
  "icons/128x128.png",
  "icons/128x128@2x.png",
  "icons/icon.png",
  "icons/icon.icns",
  "icons/icon.ico"
]
```

**Files Required:**

- `icon.icns` — macOS bundle icon (contains multiple sizes)
- `icon.png` — 512×512 (Linux/default)
- `icon.ico` — Windows icon
- `32x32.png`, `64x64.png`, `128x128.png`, `128x128@2x.png` — Various sizes

**Do NOT use runtime icon scaling.** The `.icns` file in the app bundle is read by all system services. Runtime changes only affect the Dock.

### Our Fix

We fixed the icon by:

1. Removing the white background from the source SVG
2. Scaling the logo to 83% of canvas
3. Applying proper rounded corners (229px radius)
4. Removing the runtime `objc2` hack from `main.rs`
5. Using `iconutil` to generate the `.icns` file

### Cache Clearing

After changing icons, macOS caches aggressively. To see changes:

```bash
rm -rf ~/Library/Caches/com.apple.finder/
rm -rf ~/Library/Caches/com.apple.Spotlight/
rm -rf ~/Library/Caches/com.apple.dock.iconcache
killall Finder
killall Dock
```

## Summary

1. **Performance**: Fast file operations, responsive UI
2. **Cross-platform**: Use adapters, never platform-specific code
3. **Storage**: Know what goes where (Project/URL/App)
4. **Local-first**: Trust TanStack Query, work offline
5. **Simple**: Don't over-engineer