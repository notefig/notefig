# AI Agent Guidelines for Metrists

This document outlines conventions, architectural principles, and patterns that AI assistants should follow when working on the Metrists project.

## Project Overview

Metrists is a **markdown-first, local-first text editor** that allows users to create workspaces and edit files within them. It's built as a cross-platform application using React, Tauri, and TinyBase.

## Core Principles

### 1. Performance First

Everything we build must prioritize both **perceived** and **real** performance:

- **Perceived performance**: UI should feel instant and responsive
- **Real performance**: Focus on file open time, typing latency, and sync speed
- **Not a priority**: Initial application load time (acceptable to be slower)
- **Always consider**: Virtualization, lazy loading, memoization, and debouncing
- **Bundle size**: Be mindful but not restrictive

**Performance-critical operations:**

- File opening and switching
- Editor reactivity and typing response
- TinyBase sync operations
- File tree rendering (virtualize large directories)

### 2. Cross-Platform Support

This is a **web + Tauri** application that must work on:

- macOS (Tauri)
- Linux (Tauri)
- Windows (Tauri)
- Web browsers (for development and e2e testing)

**Never** write platform-specific code directly. Always use the platform adapter pattern.

## Architecture

### Storage Architecture

We have **three distinct storage layers**:

#### A. Project Files

- **Location**: User-selected directory on disk
- **Contains**: Actual file content + project-specific settings
- **Settings stored here**: Text direction, project name, metadata tags, etc.
- **Accessed via**: TinyBase store (persisted to disk)

#### B. URL/Route State

- **Location**: Browser URL (React Router 7)
- **Contains**: Navigation and UI state
- **What goes here**:
  - `basePath` (workspace directory) → Route parameter
  - Open tabs → Search params
  - Open modals → Search params
  - File paths → URL-encoded, **absolute paths** (e.g., `/Users/name/workspace/file.md`)
- **Key utilities**: Use helpers in `src/utils/routing.ts` for encoding/decoding

#### C. Application Settings

- **Location**: Tauri stores (OS-specific locations)
- **Contains**: Application-level preferences
- **Examples**: Theme, window size, recent workspaces, global shortcuts

### State Management with TinyBase

TinyBase is our **persistence layer and state manager**. It provides a local-first reactive store.

**Key principles:**

- **Don't think about persistence**: TinyBase handles auto-save/auto-load for you
- **Store access**: Use `getOrCreateStore(basePath)` from `src/utils/tinybase.ts`
- **Workspace concept**: Each workspace (directory) has its own TinyBase store
- **Async loading**: Stores return immediately but load data in the background
- **Reactivity**: Components can subscribe to store changes for reactive updates

**Pattern:**

```typescript
// Get or create store for a workspace
const store = getOrCreateStore(basePath);

// TinyBase handles:
// - Loading data from disk
// - Auto-saving changes
// - Auto-loading updates
// - Persistence layer selection (IndexedDB for web, file system for Tauri)
```

**When working with the app:**

- Rarely think about persistence directly
- Trust that TinyBase will sync changes
- Use the store as your source of truth
- Don't manually call save/load (auto-save/auto-load handles it)

### Workspace vs Loose Files

**Current state:**

- We require a workspace directory to be selected
- Loose files are not yet fully supported (coming later)
- It's okay to assume a workspace always exists for now

**Future state:**

- Will support opening loose files without a workspace
- Still need a "virtual workspace" concept even for loose files

### Platform Adapters

For **all platform-specific operations**, use the adapter pattern:

**Location**: `src/adapters/` and `src/utils/platform.ts`

**Pattern:**

```typescript
import { platformAdapter } from "@/adapters";
import { isTauri, isWeb } from "@/utils/platform";

// Use adapter for platform operations
const dirPath = await platformAdapter.pickDirectory("Select workspace");
const persister = platformAdapter.getPersister(store, basePath);

// Check platform if needed (rare)
if (isTauri()) {
  // Tauri-specific logic
}
```

**Never:**

- Import Tauri APIs directly in components
- Use `window.__TAURI__` checks
- Write platform-specific conditional logic outside of adapters

**Current adapters:**

- `BrowserAdapter`: For web/development
- `TauriAdapter`: For native desktop apps

## Routing with React Router 7

**Library**: React Router 7

**URL structure:**

```
/:basePath/edit/:absolutePath?tabs=...&modal=...
/:basePath/preview/:absolutePath?tabs=...&modal=...
```

**Key patterns:**

- `basePath`: Route parameter (workspace directory, URL-encoded)
- `absolutePath`: Absolute file path (URL-encoded) - e.g., `/Users/name/workspace/file.md`
- Tab state, modals: Search params
- Use utilities from `src/utils/routing.ts` for encoding/decoding

**File Entry Structure:**

- Every `FileEntry` has a `path` (absolute path) and optional `relativePath`
- `relativePath` is only present for files inside the workspace
- Files outside the workspace (future: loose files) will only have `path`

## Code Organization

### Directory Structure

```
src/
├── adapters/          # Platform abstraction layer
├── components/
│   ├── editor/        # Editor-specific components
│   └── ui/            # shadcn/ui components
├── hooks/             # React hooks
├── lib/               # Third-party library configs
├── utils/             # Pure utility functions
└── ...
```

### When to use what:

**`adapters/`**: Platform-specific implementations (file system, storage)
**`components/`**: React components (UI + logic)
**`hooks/`**: React hooks (reusable stateful logic)
**`lib/`**: Configuration for external libraries
**`utils/`**: Pure functions, no React dependencies

**Hooks vs Utils:**

- **Hook**: Needs React context, state, or lifecycle (use- prefix)
- **Util**: Pure function, no React dependencies

## Editor (Plate)

We use **Plate** as our rich text editor foundation.

**Current approach:**

- Stick to base Plate configuration
- Don't over-customize unless necessary
- Keep editor simple and performant

**File locations:**

- Editor components: `src/components/editor/`
- Editor plugins: `src/components/editor/plugins/`

## Dependencies

**Policy**: No new dependencies without explicit approval.

**Rationale:**

- Keep bundle size manageable
- Reduce security surface
- Minimize maintenance burden

**When proposing a dependency:**

1. Explain why existing solutions won't work
2. Show bundle size impact
3. Demonstrate active maintenance
4. Provide alternatives considered

## Testing

**E2E Testing**: Using browser platform adapter

- Run tests against browser version
- Browser adapter provides mock file system
- Tests validate cross-platform behavior

**Current state**: E2E setup not complete yet

**Future**: Will have comprehensive E2E coverage

## Conventions

### TypeScript

- Use TypeScript strictly (no `any` without good reason)
- Prefer interfaces for public APIs
- Use types for internal shapes
- Always type component props

### React Patterns

- Functional components only
- Hooks for state and effects
- Prefer composition over inheritance
- Keep components small and focused
- Use React.memo for expensive renders

### Naming

- Components: PascalCase (`FileTree.tsx`)
- Utilities/hooks: camelCase (`useWorkspaceParams.ts`)
- Types/interfaces: PascalCase with I prefix for interfaces
- Constants: UPPER_SNAKE_CASE

### File Structure

```typescript
// 1. Imports (external, then internal)
import { useState } from "react";
import { getOrCreateStore } from "@/utils/tinybase";

// 2. Types/interfaces
interface MyComponentProps {
  basePath: string;
}

// 3. Component
export function MyComponent({ basePath }: MyComponentProps) {
  // Component logic
}
```

## Common Patterns

### Opening/Loading a Workspace

```typescript
// 1. User selects directory
const basePath = await platformAdapter.pickDirectory("Select workspace");

// 2. Navigate to workspace route
navigate(`/${encodePathForUrl(basePath)}`);

// 3. Get/create store (TinyBase handles loading)
const store = getOrCreateStore(basePath);

// 4. Store populates asynchronously - UI can subscribe to changes
```

### Working with Files

```typescript
// Reading current workspace from URL
const { basePath } = useParams();
const decodedBasePath = getBasePathFromUrl(basePath);

// Building file URLs with absolute paths
const fileUrl = buildEditFileUrl(basePath, absoluteFilePath);

// Getting absolute path from URL
const absolutePath = getAbsolutePathFromUrl(encodedAbsolutePath);

// File entries always have absolute path
const file: FileEntry = {
  path: "/Users/name/workspace/file.md", // Absolute path
  relativePath: "file.md", // Optional - only for files in workspace
  type: "file",
  // ... other properties
};
```

### Platform-Specific Operations

```typescript
// Always use adapter
const result = await platformAdapter.pickDirectory("Choose folder");

// Never do this:
if (window.__TAURI__) {
  /* ... */
} // ❌ Wrong
```

### Performance Optimization

```typescript
// Memoize expensive computations
const sortedFiles = useMemo(() =>
  files.sort((a, b) => a.name.localeCompare(b.name)),
  [files]
);

// Debounce rapid updates
const debouncedSave = useDebounce(saveContent, 500);

// Virtualize long lists
<VirtualizedList items={files} />
```

## Error Handling

- Always handle async errors (try/catch or .catch())
- Provide user-friendly error messages
- Log errors to console with context
- Don't let errors crash the app

## Accessibility

- Use semantic HTML
- Provide keyboard shortcuts for key actions
- Ensure focus management in modals
- Test with keyboard-only navigation

## Questions to Ask

When implementing a feature, ask yourself:

1. **Performance**: Will this feel instant? Will it scale to 10,000 files?
2. **Cross-platform**: Does this work in both browser and Tauri?
3. **Storage**: Where should this data live? (Project/URL/App settings)
4. **Local-first**: Does this work offline? Does it sync properly?
5. **Dependencies**: Can I do this without adding a new package?

## Anti-Patterns

**Don't:**

- ❌ Import Tauri APIs directly
- ❌ Manually save/load TinyBase stores
- ❌ Put navigation state in TinyBase (use URL)
- ❌ Put ephemeral UI state in TinyBase (use React state)
- ❌ Add dependencies without asking
- ❌ Block the UI thread with heavy computation
- ❌ Assume files are small (virtualize lists)
- ❌ Hard-code platform checks outside adapters

**Do:**

- ✅ Use platform adapters
- ✅ Trust TinyBase auto-save/auto-load
- ✅ Put navigation state in URL
- ✅ Use React state for UI-only state
- ✅ Ask before adding dependencies
- ✅ Use web workers for heavy computation
- ✅ Virtualize large lists
- ✅ Keep platform logic in adapters

## Summary

When working on Metrists:

1. **Think performance**: File operations must be fast and responsive
2. **Think cross-platform**: Use adapters, never platform-specific code
3. **Think storage**: Know what goes where (Project/URL/App)
4. **Think local-first**: Trust TinyBase, work offline
5. **Think simple**: Don't over-engineer, keep it maintainable

This is a markdown editor. Keep the focus on making file editing fast, reliable, and delightful across all platforms.
