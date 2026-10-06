# Metrists Monorepo - AI Agent Guidelines

## Repository Structure

This is a monorepo containing the Metrists CLI and Desktop applications, along with shared code.

```
packages/
├── cli/              # CLI package (published to npm as 'notefig')
├── desktop/          # Desktop app (Tauri + React, published as binaries)
├── core/             # Kernel: module registration, boot order, workspace lifetime, hooks (source-only)
├── shared/           # Internal shared package (not published)
│   ├── src/
│   │   ├── types/    # Shared TypeScript types
│   │   ├── utils/    # Utility functions
│   │   ├── parsing/  # Markdown/content parsing
│   │   └── validation/  # Zod schemas
│   └── package.json
└── themes/           # Theme packages
```

## Package Management

- **Tool**: npm workspaces
- **Node version**: 22+ (check `.nvmrc`). The CLI ships the Claude ACP adapter, which needs Node 22+.
- **Install all dependencies**: `npm ci` at root

## Key Commands

```bash
# Build all packages
npm run build

# Development
npm run dev:cli          # CLI in watch mode
npm run dev:desktop      # Desktop dev server

# Testing
npm run test             # All tests
npm run test:cli         # CLI tests only
npm run test:desktop     # Desktop unit tests only

# Linting
npm run lint             # All packages
npm run lint:cli         # CLI only
```

## Shared Package Usage

When adding code that both CLI and Desktop need:

1. Add to `packages/shared/src/` in appropriate folder
2. Export from `packages/shared/src/index.ts`
3. Import in CLI/Desktop: `import { something } from "@notefig/shared"`

Example:
```typescript
// packages/shared/src/parsing/markdown.ts
export function parseMarkdown(content: string) { ... }

// packages/shared/src/index.ts
export * from "./parsing/index.js";

// In CLI or Desktop
import { parseMarkdown } from "@notefig/shared";
```

## Core Modules

The desktop app boots through `@notefig/core` (`packages/core`). Each root
(`packages/desktop/src/main.tsx`, `packages/marketing/site/main.tsx`) picks a
module list from `packages/desktop/src/core/app-core.ts`, then calls
`core.boot()` before render.

- Something that has to run for the life of the app (a subscription, a
  tracker, a startup scan) is a module declared with `defineModule` next to
  the code it starts, and added to a list in `app-core.ts`. Never add a
  module-scope side effect or a startup `useEffect` in `App.tsx` for this.
- Every module lives in its own folder under `packages/desktop/src/modules/`
  (`modules/files/`, `modules/tabs/`, `modules/agents/`…), whatever its
  kind: an app-wide service, a per-workspace instance, or a boot-only
  behaviour. The folder holds the factory and the module (`files.ts`), its
  tests, and `index.ts`, the barrel other code imports (`@/modules/files`).
  React hooks over the module live in `react.ts` and are imported from
  `@/modules/files/react`, so nothing that imports the barrel pulls React.
  `components/`, `hooks/` and `utils/` hold what their names say: views,
  React-only hooks, and pure functions. A `defineModule` never sits inside
  a component file.
- `needs` decides order: core registers and boots a module after everything
  it lists, and fails at startup on a service the root did not provide or
  a cycle. Every entry is the module itself (`needs: [kvModule,
  platformModule]`, `workspace: { needs: [filesModule] }`); a needed module
  the root left out is registered anyway. Services are modules too:
  `platformModule`, `queryClientModule` and `urlModule`
  (`src/core/services.ts`, `defineService`) carry the value the root
  provides. Reading what was handed over is by name, checked by
  TypeScript: `ctx.use("kv")`, `ctx.use("platform")`,
  `ctx.useWorkspace("files")`. A module takes no options: what differs
  per root is a separate module the root lists (`restoreWorkspacesModule`
  in the desktop list only).
- A module that exposes an API, or that other modules need, declares itself
  on `CoreModules` (`declare module "@notefig/core"`). Per-workspace state
  goes on `WorkspaceModules` with a `workspace: { create, dispose }` part.
- Anything a workspace holds that must be torn down when it closes (a
  process, a worker, a cache) is released in that module's `dispose`, never
  by hand in `closeWorkspace`. Core disposes in reverse `needs` order.
- Every piece of state is built by a factory from what it is handed, and
  a module calls that factory with what core hands it. The entity exports
  the factory (`createWorkspaceGit(deps)`, `createKv(persistence)`,
  `createAgentStore(persistence)`), which is also what its tests build —
  no module mocks. Per-workspace state is built in `workspace.create`
  (`ctx.use("platform")`, the workspace's other instances via
  `ctx.useWorkspace`) and freed in `dispose`; app-wide state in `register`.
  Persisted collections are created inside the factory from
  `ctx.use("platform").db`, never at module scope. The same goes for any
  registry: a map of live editor instances, writes in flight, tabs
  mid-rename — each is state of the module that owns it (`core.editors`,
  `core.documents`, `core.tabs`), reached through core, never a
  module-scope `Map` a free function reads.
- The platform is a service. Only the composition root (`app-core.ts`)
  imports `@/adapters`; modules take `ctx.use("platform")`, components
  `useCore().platform`, and other code is handed
  the surface it needs (`fs: Pick<FileSystemSurface, …>`). Fallow's
  boundary rules (the root `.fallowrc.json`, which CI audits from) fail a
  commit that imports an adapter implementation from app code. There is no
  ambient core: code outside React is handed what it uses.
- A per-workspace API is reached through core: `core.workspace(ws).git`,
  or `useWorkspaceModule(ws, "git")` in React; an app-wide one and every
  service straight off core: `core.kv`, `const { kv, platform } =
  useCore()`. No hook only hands back what core already exposes
  (`useAgents()`, `usePlatform()`); a hook in `react.ts` earns its place by
  doing something — a live query, a subscription, a join.
- Tests build what they exercise over fakes: `createTestCore` (a platform
  over an in-memory db by default), `testWorkspaceFiles` / `filesModuleOf`
  (`src/testing/test-files.ts`), `testKv`, `testAgents` (store, runtime
  and facade, `src/testing/test-agents.ts`).
- There is one event bus: core's hooks. A module declares the moments it
  announces in `CoreHookMap` (next to its `declare module "@notefig/core"`
  block, e.g. `"git:stale"` in git, `"files:changed"` in files, the
  `"agent:*"` moments in `src/modules/agents/agent-events.ts`) and emits them with
  `ctx.hooks.emit`; a factory that announces is handed `hooks` like any
  other dependency. Listeners subscribe in `boot` or `workspace.create`
  with `ctx.hooks.on` and return the unsubscribe, so core tears them down.
  A per-workspace listener checks the payload's workspace against its own.
  Agent tools get their workspace's instances on `ctx.services`
  (`ToolServices`, widened by declaration merging).
- A workspace is opened, focused and closed through its handle:
  `core.workspace(path).open()` (the user enters it), `.focus()` (brought
  forward, as the switcher does), `.close()`. What entering or focusing
  should also do is a module's handler for `workspace:entered` or
  `workspace:focused` (the scratchpad landing, the sidebar's files view, the
  open-set row), never code in the caller. A boot restore fires neither.
  Those handlers are steps of the open: if one fails, `open()` rejects and
  the hooks after it don't fire (a failed `focused` lands nothing).
- Agents are driven through the facade (`core.agents`, `useCore().agents`
  in React): `agents.workspace(ws).start(harness)` for a session the user
  starts (runtime and trust gates included), `agents.task(id)` for
  everything after. Their rows are read through `core.agentStore` (the
  hooks in `@/modules/agents/react` join them). Nothing outside
  `src/modules/agents/` reaches the runtime in `agent-service`.
- The plan this follows: the "Core Layer Architecture" doc (stages 1–7).

## Release Process

Both CLI and Desktop have **independent, manual releases**:

### CLI Release
1. Go to GitHub Actions → "Release CLI Package"
2. Click "Run workflow"
3. Enter version (e.g., `0.8.0`)
4. Workflow creates:
   - Commit bumping version
   - Tag: `cli-v0.8.0`
   - GitHub Release
   - npm publish

### Desktop Release
1. Go to GitHub Actions → "Release Desktop App"
2. Click "Run workflow"
3. Enter version (e.g., `0.0.40`)
4. Workflow creates:
   - Commit bumping version
   - Tag: `desktop-v0.0.40`
   - GitHub Release with binaries
   - Cloudflare Pages deployment

### Tagging Convention
- CLI: `cli-v{semver}` (e.g., `cli-v0.7.4`)
- Desktop: `desktop-v{semver}` (e.g., `desktop-v0.0.40`)

This prevents conflicts and allows independent versioning.

## CI/CD Workflows

All workflows are in `.github/workflows/`:

- `ci-tests.yml` - Runs on every PR/push to main/develop
  - Tests CLI, Desktop unit tests, Desktop Tauri tests
  - Lints CLI and shared package

- `release-cli.yml` - Manual trigger for CLI releases

- `release-desktop.yml` - Manual trigger for Desktop releases

## Adding Dependencies

### To a specific package:
```bash
cd packages/cli
npm install some-package
```

### To shared (available to both):
```bash
cd packages/shared
npm install some-package
```

Both CLI and Desktop already have `@notefig/shared` as a dependency.

## TypeScript Configuration

- Shared package uses `composite: true` for project references
- Both CLI and Desktop can import from shared without additional tsconfig changes
- Build shared first: `npm run build:shared`

## Testing

Tests run automatically on PRs via GitHub Actions. Test files:
- CLI: `packages/cli/**/*.test.ts` (Jest)
- Desktop: `packages/desktop/**/*.test.ts` (Vitest)
- Desktop E2E: `packages/desktop/tests/e2e/` (Playwright)

### Playwright / Browser Debugging

The desktop app runs in browser mode via `npm run dev:desktop` (Vite dev server on port 1420).

**Forcing the IndexedDB adapter:** In Playwright's Chromium, `window.showDirectoryPicker` exists and causes the app to use the File System Access API adapter, which requires OS file picker dialogs. To use the pure IndexedDB adapter (testable without OS dialogs), inject this before page load:

```js
await page.addInitScript(() => {
  window.__METRISTS_FORCE_INDEXEDDB__ = true;
});
```

Then seed test files in the `metrists-fs` IndexedDB and navigate to `/<workspace-path>`.

The `BrowserPlatformAdapter.pickDirectory()` dispatches a `mock-pick-directory` CustomEvent on `window`. Listen for it and respond with a workspace path:

```js
window.addEventListener('mock-pick-directory', (e) => {
  const { callback } = e.detail;
  callback('/playwright-test-workspace');
});
```

## Important Notes

1. **Desktop package name changed**: Was `metrists`, now `@notefig/desktop` (private)
2. **CLI package name**: `notefig` (published to npm; renamed from `metrists`)
3. **Shared is private**: Never publish `packages/shared/`
4. **Always build shared first** before building CLI or Desktop
5. **Desktop workflow untouched**: The release logic is identical, only file location changed

## Migration from Old Structure

If you see references to:
- `packages/cli/.github/workflows/` - Moved to root, now deleted
- Manual npm publish from root - Use `release-cli.yml` workflow instead
- Desktop as `metrists` package - Now `@notefig/desktop`
