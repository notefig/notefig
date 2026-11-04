# Spike 04 — App shell and platform: Tauri/React → Rust/GPUI

Scope: everything that is not editor internals, agents, or git. That covers the kernel (`packages/core`), the composition root, the platform adapter surfaces, workspaces, files, the tree, tabs and dock, the sidebar, persistence, themes, keybindings and the palette, window chrome, settings, telemetry, updater, feedback, tunnel, dictation, the Tauri backend inventory, and the perf SLOs.

Source read at `4a6555c1` (main, /Users/parsa/Documents/notefig-gpui). Paths below are relative to `packages/`. The shell slice is about 27k lines of TS/TSX, not counting tests: modules, adapters, hooks, shell components, `core`, `ui` and `dictation`. The Tauri backend is 7.6k lines of Rust (`desktop/src-tauri/src`). About 4k of those lines carry over almost unchanged (fs_ops, file_watcher, search, walkdir_utils, db_ops).

---

## 1. Kernel: module/boot architecture today

**Files:** `core/src/{types,define-module,create-core,hooks,order}.ts` (create-core is 471 lines), `desktop/src/core/{app-core,services,start-app}.ts(x)`.

- **`defineModule({ name, needs, register, boot, workspace: { needs, create, dispose } })`** is an identity function used for inference. The parts:
  - `register(ctx)` builds the app-wide API.
  - `boot(api, ctx)` starts subscriptions synchronously and returns a disposer.
  - `workspace.create(ctx, api)` and `workspace.dispose(instance, ref, api)` handle per-workspace state.
- **Typed registries use TS declaration merging.** `CoreServices` holds `platform`, `queryClient` and `url`, as declared in `desktop/src/core/services.ts`. Modules add their APIs to `CoreModules`, per-workspace instances to `WorkspaceModules`, and events to `CoreHookMap`. Lookups are checked by name: `ctx.use("kv")`, `ctx.useWorkspace("files")`.
- **Ordering** (`order.ts`): a topological sort over `needs` plus `workspace.needs`. Modules that are needed but not listed get added automatically. Startup throws `CoreConfigError` on a cycle, a duplicate, or a workspace need on a module with no workspace part. Unconstrained modules keep their list order. Services are modules too (`defineService("platform")`).
- **Workspace lifecycle** (`create-core.ts`):
  - `core.workspace(path)` returns a handle: `open()`, `focus()`, `close()` and `isOpen()`, plus read access to the instances (`handle.files`).
  - Workspaces are keyed by `workspaceKey(path)`, which lowercases on Windows and strips trailing separators.
  - `lifecycle.open` creates instances in need order and fires `workspace:opened`.
  - `handle.open()` runs `open`, then the awaited `emitSerial("workspace:focused")`, then `emitSerial("workspace:entered")`. If any step fails, it rejects with `WorkspaceOpenError` and skips the rest.
  - `close` runs the awaited `workspace:closing`, then disposes instances in reverse need order.
  - Concurrency control: a ticket per key (`latestCall`). An open that waited on a close or rollback gives up if it has been superseded. Opens that run at the same time join each other. A failed open rolls back what it built.
  - `core:booted` and `core:shutdown` are the global moments.
- **Hooks** (`hooks.ts`):
  - `on` returns an unsubscribe function.
  - `emit` is fire-and-forget; errors are reported and the other handlers still run.
  - `emitSerial` awaits each handler in order and returns the failures.
- **The two module lists** (`app-core.ts`):
  - `runtimeModules()` has 31 modules: kv, seen, prompt-rounds, turn-writes, tree-inline-edit, workspaces, recent-documents, layout, tabs, editors, documents, project-settings, scratchpad-landing, sidebar-view, files, git, scratchpads, git-worker, history, agent-store, directives, prompt-widgets, diff-blocks, mock-agent, workspace-agents, shared-sessions, usage, tree-expansion, lastTool and feedback.
  - `desktopModules()` adds restore-workspaces, session, harness-probe, tunnel, telemetry and dictation.
  - The marketing site uses the runtime list only.
- **Boot sequence** (`start-app.tsx`): a data router supplies `url: UrlState`. Then `createCore({services:{platform, queryClient, url}})`, then `core.boot()` (synchronous), then render. The core is exposed as `window.__notefigCore` in dev and test builds.

### Mapping to GPUI

| TS concept | GPUI equivalent |
|---|---|
| `Core` + `CoreModules` registry | Each app-wide module is an `Entity<T>` behind a `Global` newtype (`struct GlobalKv(Entity<Kv>); impl Global`), reached via `Kv::global(cx)`. Rust has no declaration merging, so the registry becomes plain typed accessors, checked by the compiler. |
| `needs` topo-sort | Explicit `init(cx)` calls in `main.rs`, in dependency order, which is the Zed idiom (`kv::init(cx); workspaces::init(cx); …`). An `init` that reads a missing global panics at startup, which is the analogue of `CoreConfigError`. A cycle cannot compile if each `init` takes its dependencies' entities as arguments. Recommendation: take dependencies as arguments, not as `cx.global` lookups, so the order is compiler-checked. |
| `CoreServices.platform` | A `Platform` struct of trait objects: `Arc<dyn Fs>`, `Arc<dyn Db>`, `Arc<dyn Dialogs>`, `Arc<dyn Proc>`, `Arc<dyn Updater>`, stored as a `Global`. Native and wasm impls are chosen in `main.rs` only, which keeps the "only app-core imports adapters" rule. Zed's `fs::Fs` trait with `RealFs`/`FakeFs` is the model (re-implement it, don't copy it; see licensing risk). |
| `WorkspaceModules` per-workspace instances | `Entity<Workspace>` with typed fields (`files: Entity<WorkspaceFiles>`, `git`, `scratchpads`, `tree_expansion`, `last_tool`, `agents`, …). It is built in `Workspace::new(ref, &Platform, cx)` in dependency order. One struct replaces the map. |
| `workspace.dispose` (reverse order) | An explicit `async fn dispose(self, cx)` on `Workspace` that tears down fields in reverse construction order. Don't rely on `Drop` order, because Rust drops fields in declaration order, which is the opposite of what we want. Releasing a `notify` debouncer, a child process or a worker is done in `Drop` impls as a backstop. |
| `hooks.emit` (sync, fire-and-forget) | Per-emitter `impl EventEmitter<FilesEvent> for WorkspaceFiles`, with `cx.subscribe(&files, |this, _, ev, cx| …)` returning a `Subscription` whose drop unsubscribes. The "boot returns its disposer" rule maps to the module keeping its `Vec<Subscription>`. AGENTS.md's "one bus" rule can be kept as a `CoreEvents` entity that holds one `enum CoreEvent` across crates. The enum must live in a leaf crate because there is no merging. Recommendation: per-emitter events, plus one bus only for the cross-cutting `agent:*` events. |
| `emitSerial` (`workspace:focused/entered/closing`, `core:shutdown`) | GPUI events are synchronous, so these become **async step lists** owned by `WorkspaceRegistry`: `Vec<Box<dyn Fn(WorkspaceRef, &mut AsyncApp) -> Task<anyhow::Result<()>>>>`, run sequentially by `open()`/`close()`. Failures produce `WorkspaceOpenError`. Port the ticket/supersede logic verbatim (about 150 lines). |
| `useKv`, `useLiveQuery`, `useSyncExternalStore` | A view holds `Entity<…>` plus `cx.observe(&entity, |_, _, cx| cx.notify())`. Derived joins become small entities, or are computed in `render` from `read(cx)`. |
| TanStack Query (`queryClient`) | No equivalent is needed. Loading and error state become explicit enum fields. Retry, refetch interval and stale time become `cx.spawn` loops with `Timer::after`. |
| `UrlState` / router (`?layout=…&sidebarView=…`) | A `Session` entity. See §5. |
| `window.__notefigCore` test seam | `#[gpui::test]` with `TestAppContext`. Workspace-module tests build `Workspace` over `FakeFs` plus in-memory SQLite. This matches the "factories over fakes, no module mocks" rule exactly. |

Async model: GPUI has its own executors (`cx.background_spawn`, `cx.spawn`), not tokio. `fs_ops.rs`, `file_watcher.rs` and `search.rs` are written against `tokio::fs`. Port them to `smol`/`async-fs`, or run blocking `std::fs` on `background_executor` (simpler, and what Zed's RealFs does). `notify` callbacks arrive on its own thread. Forward them through a `futures::channel::mpsc` drained by a `cx.spawn` loop that updates the `WorkspaceFiles` entity.

---

## 2. Platform surfaces (`desktop/src/adapters/platform-adapter.interface.ts`, 606 lines)

`IPlatformAdapter = { fs, proc, db, ui, updates }`. There are three implementations, picked in `adapters/index.ts`:

- **`TauriPlatformAdapter`** (`tauri-adapter.ts`, 848 lines): `invoke`/`listen`, `@tauri-apps/plugin-{dialog,opener,updater,process}`, `convertFileSrc` (asset protocol).
- **`BrowserFsPlatformAdapter`** (`browser-fs-adapter.ts`): the File System Access API (`showDirectoryPicker`). Handles persist in IndexedDB `notefig-fs-handles`. `requestWorkspaceAccess` must run inside a user gesture.
- **`BrowserPlatformAdapter`** (`browser-adapter.ts`): pure IndexedDB (`metrists-fs`). Used by e2e via `window.__METRISTS_FORCE_INDEXEDDB__`. `pickDirectory` dispatches `mock-pick-directory`.

Both browser variants share `base-browser-adapter.ts`, the OPFS SQLite db and `browser-file-watcher.ts`. The watcher polls: metadata every 5 s, content every 3 s, FS Access only.

| Surface | Methods | Notes |
|---|---|---|
| `fs` | `requestWorkspaceAccess`, `readDirectory(recursive, includeFiles/Dirs/Hidden, ignore)`, `createDirectories`, `deleteDirectories(recursive)`, `moveDirectory`, `readFiles`, `readBinaryFiles`, `writeFiles`, `createFiles`, `deleteFiles`, `moveFile`, `copyFile`, `writeBinaryFiles`, `resolveAssetUrl`, `exists`, `getMetadata`, `startWatchingMetadata(paths, watchId, ignore)`, `startWatchingContent(paths, watchId)`, `stopWatching`, `onFsEvent`, `searchContent(dir, {query, useRegex, caseSensitive, filePattern, fileIncludes, maxResults, ignore})` | Errors are values: `Result`/`BatchResult`, plus `FsError` with `FileSystemErrorType` (not_found, permission_denied, handle_missing, already_exists, invalid_path, not_empty, is_directory, is_file, io_error, unknown). Search results are `{filePath, matchText, lineText, occurrence}`. Line and column are deliberately not exposed. |
| `proc` | `createAgentTransport`, `createMcpEndpoint`, `runShellCommand` | **Agents spike.** In the Rust app, transports become direct `async-process` children. No IPC. |
| `db` | `get(): PersistedCollectionPersistence` | TanStack DB SQLite persistence, driver only. See §6. |
| `ui` | `pickDirectory`, `promptText`, `openExternal` (http/https/mailto, plus `x-apple.systempreferences:`), `toggleFullscreen`, `publishAppStatus`, `addEventListener` | Platform events: `theme-changed`, `folder-selected`, `file-dropped`, `zoom-changed`. |
| `updates` | `check` / `apply` (async generator of progress) / `restart` | Flows: `download-restart` (desktop) or `refresh` (web). |

Watch ids are `metadata-${PORTAL_ID}-${ws}` and `content-…` (`modules/files/file-sync.ts`). The Rust registry is process-global and scoped per webview. In GPUI there is one process and N windows, so a watcher owned by `WorkspaceFiles` makes watch ids unnecessary.

`git-storage-host.ts` builds the git host above the fs surface and belongs to the git spike.

---

## 3. Workspaces lifecycle

**`modules/workspaces/workspaces.ts`**: `WorkspaceRegistry` is `core.workspaceRegistry`.

- **Open set:** a persisted collection `open-workspaces` with rows `{key, path, openedAt, focusedAt}`. Focus is the row with the highest `focusedAt`; there is no second store for it. There is no TTL or LRU: a workspace stays open, watchers armed and agents alive, until it is explicitly closed (switcher, error recovery, teardown).
- **`mirror(lifecycle)`:** row inserts become `lifecycle.open`, deletes become `close`. On `workspace:focused` it calls `recordFocus`, which inserts or updates the row and waits until the write is durable. On `workspace:closing` it calls `forget(key)`, synchronously.
- **`restoreWorkspacesModule`** (desktop only): `restore()` preloads the rows and opens each one, then `whenReady()`.
- **Writes wait for hydration** (`preload`). A write made before hydration is silently dropped by the persistence stream; this is pinned by `workspaces-restore.test.ts` and `kv-hydration.test.tsx`. A Rust store with synchronous load at boot removes this whole class of bug.
- **`workspaceOf(absPath)`** finds the owning workspace by tree membership: the deepest open root wins, and string prefixes don't count (`relativeTreePath`). The dock is one layout over all open workspaces, so every tab finds its workspace this way.
- **Entry handlers** (`workspace:entered`):
  - `scratchpad-landing` (`modules/scratchpads/landing.ts`): if the workspace has no file tab, it opens the most recent scratchpad or a new one. It always sweeps empty abandoned scratchpads.
  - `sidebar-view` switches Everything to Files.
  - On `workspace:focused`, `files` runs `ensureWatching` plus `catchUp(10 s)`.
- **Recent projects:** kv `recentProjects`, `{name, lastOpenedAt}`, max 20 (`hooks/use-recent-projects.ts`). Shown on Welcome (`components/welcome.tsx`, 489 lines) and in the global column switcher (`components/editor/global-column.tsx`).
- **Close:** `components/editor/close-workspace-dialog.tsx` confirms when agents are live. Agent rows demote to "restored" when the agents instance is disposed (MET-54).
- **Error path:** `workspace-error-boundary.tsx` catches `isWorkspaceAccessError` (permission_denied or handle_missing) and offers re-grant or re-pick.

**GPUI:** `Entity<WorkspaceRegistry>` (Global) holds `rows: Vec<OpenWorkspaceRow>` loaded synchronously from SQLite in `init`, plus `open: HashMap<Key, Entity<Workspace>>`. `open/focus/close` return `Task<Result<()>>` and run the async step lists. One window shows all open workspaces, matching today's single-dock model. Multi-window is a later option.

---

## 4. Files and file tree

### Files model (`modules/files/files.ts`, 1015 lines; `file-sync.ts`, 346; `file-search.ts`, 203)

- **Two collections per workspace**, both TanStack Query collections over the fs:
  - Metadata: `{path, relativePath, type, modified, size, contentHash}`, loaded eagerly by the listing walk. Refetch runs every 30 s; a listing counts as fresh for 10 s; invalidation is debounced 500 ms.
  - Content: `{path, content, contentHash}`, loaded on demand for open tabs.
- **`WorkspaceFiles` API:**
  - `file(path)` returns a handle with `exists`, `metadata`, `content`, `create`, `createDirectory`, `write`, `rename`, `delete`, `entry`, `prefetch`.
  - Other methods: `refresh`, `catchUp(maxAge)`, `refetchMetadata`, `hydrateDirectoryStats(dirs)` (lazy stats for date sort), `updateLoadedContent`, `changed(paths)`, `watchContent(paths)`, `ensureWatching`, `reload`, `dispose`.
  - Emits `files:changed {workspacePath, paths}`. Project settings consumes it.
- **Watcher application** (`file-sync.ts`): created, deleted and renamed events update the metadata rows. Content events update loaded content, with a hash compare against the app's own writes. `isIgnoredPath` is the authoritative backstop.
- **Echo suppression is Rust-side:** `fs_ops::write_file` calls `file_watcher::register_app_write(path, md5)`, and the watcher drops events whose content hash matches a recent app write. This carries over directly.
- **Ignore rules** (`utils/ignore.ts`) are a denylist. Directories: node_modules, bower_components, vendor, target, dist, build, out, coverage, `__pycache__`, venv, Pods, DerivedData. Extensions: archives, binaries, and so on. Hidden files are excluded, except `.notefig/scratchpads/`, the only child of the app dir that is surfaced. The git host deliberately walks unfiltered.
- **File search** (quick switcher, MET-255): each workspace's metadata is ranked separately (`utils/file-score.ts`), the top N per workspace are merged, and the ranking is cached by a per-workspace version.
- **Content search:** `searchContent` uses ripgrep's `grep` crates in `search.rs`. The UI is `components/editor/search-panel.tsx`.
- **Project settings** (`modules/project-settings`): `metrists.json` at the workspace root holds `{workspace:{name,created,version}, settings:{direction:"ltr"|"rtl"}}`. It is invalidated by `files:changed` and only created on the first `update`.

**GPUI:** `WorkspaceFiles` is an entity holding a `BTreeMap<RelPath, Entry>` snapshot (Zed `Worktree`-like but much simpler) with a `version: u64`.
- The walk uses the `ignore` crate's `WalkParallel` with our denylist (or keep `walkdir_utils.rs`), on the background executor. It sends batches, so the tree appears progressively.
- The watcher is `notify` plus `notify-debouncer-full` at 100 ms, reusing `file_watcher.rs::process_events` with the Tauri `emit` swapped for a channel. That includes rename pairing, the symlink-root spellings (`/tmp` vs `/private/tmp`) and ignore filtering.
- Content is a `HashMap<PathBuf, Loaded{text, hash}>` for open tabs only. Editor buffers belong to the editor spike, which owns how buffer, disk and agent writes reconcile.

### File tree view (`components/editor/file-tree.tsx`, 856 lines; `tree-model-cache.ts`, 303; `tree-stat-hydration.ts`; `modules/tree-expansion`; `modules/tree-inline-edit`)

Rendered by `@pierre/trees`: a virtualized ARIA tree in a shadow DOM. Features to reach parity on:

1. **Virtualization** for 20k-entry workspaces, with keyboard navigation (arrows, Enter, type-ahead from the library).
2. **Sort:** `name-asc`, `name-desc`, `date-modified`. Date sort lazily hydrates directory stats and re-sorts as they arrive.
3. **Inline rename and inline create** (file or folder) as a row input. `FileTreeMode` is `idle | renaming{path} | creating{parentPath,itemType}`. The `tree-inline-edit` module exists only to fix a DOM blur-ordering bug, where a press outside the tree commits the edit and the tree steals focus back. **It disappears in GPUI**, because focus is explicit (`FocusHandle`, `on_blur`).
4. **Context menu:** open, open in new tab, rename, delete with an `AlertDialog` confirm, new file, new folder. Protected paths come from `isProtectedTreePath` (the scratchpads dir).
5. **Click behaviour:** Mod+click opens in a new tab. Built-in multi-select is suppressed.
6. **Drag:**
   - Internal move is the library's native drag. Moving an **open** file goes through `tabs.renameOpenFile`, a close-and-reopen rename.
   - Dragging a row onto a dock tab bar opens it there (`utils/drag-protocol.ts`, `tagCurrentDrag`).
   - An image asset dropped on a folder is placed by hit-testing (`utils/drop-actions.ts::moveIntoFolder`).
7. **Expansion memory** (`tree-expansion.ts`) is per open workspace and **in memory only**: it is lost on restart or close. The tree model outlives the component across sidebar view switches, keeping expansion, scroll, focus and selection. Persisting it to kv would be a cheap improvement in the port.
8. **Reconciliation:** a path-set signature (`pathsSignature`) means an unchanged remount never resets. A reset never interrupts an inline edit in progress; it retries later.
9. **Theming** uses `--trees-theme-*` tokens (`styles.css` around line 728).

**GPUI:** a `FileTreeModel` holds `expanded: HashSet<RelPath>` and a flattened `visible: Vec<RowId>` rebuilt on snapshot version change. It lives on the `Workspace`, not on the view, so it survives remounts by construction. The view is a `uniform_list` (fixed row height, like Zed's project panel). Rename and create use a gpui-component `Input` in the row. The context menu is gpui-component's `ContextMenu`/`PopupMenu`. Drag uses `on_drag(DraggedPath)` and `on_drop`; the dock tab bar accepts the same `DraggedPath` type, so there is no "protocol" shim. External drops arrive as `ExternalPaths`. gpui-component has a `Tree`/`List` primitive, but a custom `uniform_list` gives full control. **Effort: 2.5 person-weeks.**

---

## 5. Tabs, dock layout, and session persistence

- **Layout model** (`components/dockable/utils/serializeLayout.ts`, `reducer.ts` at 319 lines):
  ```
  LayoutNode = Panel{id, orientation: row|column, size, children: LayoutNode[]}
             | Window{id, selected: TabId, children: TabId[], size}
  ```
  Reducer actions: `resize`, `addPanel`, `reorderTabs`, `selectTab`, `moveTab`, `splitWindow{direction: Left|Right|Top|Bottom}`, `insertPanel`, `setState`, plus `cleanup` of empty windows. Rendering is dnd-kit (`dndkit/*`, collision `dockableCollision.ts`) plus a custom `panelgroup/` with resize handles.
- **Dock chrome** (`store.ts`): `tabBarLeading` (the collapsed sidebar header), `tabBarTrailing` (Windows window controls), and `endInset` (macOS lights in RTL).
- **Tab ids** (`modules/tabs/tab-id.ts`): an absolute file path makes a file tab, `agent:<taskId>` makes an agent tab, and `release:` is the release-notes singleton. `parseTabId` is the only decoder. Per-kind controllers (`tab-controllers.ts`) and renderers (`tab-types.tsx`) are registered per kind.
- **`TabsApi`** (`modules/tabs/tabs.ts`, 637 lines) is `core.tabs` and the only way the app changes tabs.
  - Calls: `open(tabId, {intent})` (intents come from `utils/dockable-layout.ts::openFileInLayout`), `openAgent`, `select`, `focus`, `close`, `reveal(location)`, `rename`, `renameOpenFile`, `renaming()`, `applyLayout`, `activeTabId`, `activeWindowId`, `activeWindowTabs`, `focusWindow(next|prev|up|down|left|right)`, `subscribe`.
  - `tab(id)` returns a handle with `focus`, `selectedText`, `search`, `revealMatch`, plus `.editor` or `.agent`.
- **Layout persistence today:** the `layout` module (`modules/layout/layout.ts`) keeps the **URL** as its source of truth (`?layout=<json>`). Other chrome is URL-held too: `sidebarView` (everything|files|search|git|sessions, `modules/sidebar-view`), `sidebar=collapsed`, `settings=<section>` (settings modal) and `debug=true`. The `session` module (`modules/session/session.ts`) writes the whole search string to kv `session.lastSearch` on every change and restores it on a cold boot, when the URL is a bare `/`. Layout updates push history entries; nothing visible relies on back and forward.
- **Window focus:** `focusedWindowModule` plus `utils/focus-arbiter.ts` decide which pane is focused.

**GPUI:**
- Replace `UrlState` with an `Entity<Session>`:
  ```rust
  struct Session {
      layout: LayoutNode,
      sidebar_view: SidebarView,
      sidebar_collapsed: bool,
      sidebar_width_rem: f32,
      settings_section: Option<Section>,
      debug: bool,
  }
  ```
  `LayoutNode` is `#[derive(Serialize, Deserialize)] #[serde(tag = "type")]`, which is JSON-compatible with today's shape. That allows a **one-time import of `lastSearch`'s `layout` param**.
- Saves are debounced (about 250 ms) to kv `session`.
- **Port `reducer.ts` and `utils/dockable-layout.ts` as a pure Rust module with unit tests.** Agent tools and hotkeys mutate the layout programmatically, so owning the model matters more than reusing a widget's internal state.
- Rendering: gpui-component `h_resizable`/`v_resizable` for splits, a `TabBar` per window, and `on_drag(DraggedTab)` with a drop overlay that shows the 4 edge zones plus center.
- **gpui-component's `DockArea`** (with `Panel` trait, `TabPanel`, `StackPanel`, `DockAreaState` serialization) is a viable alternative. It has left, right and bottom docks and split-by-drag. Its state model is panel-registry-based, so tab ids would map to `Panel`s through a factory. Decide in a 2–3 day sub-spike. Recommendation: own model plus gpui-component primitives.
- **Effort: 3 person-weeks.**

---

## 6. Sidebar views

`components/editor/sidebar.tsx` (715 lines), `global-column.tsx` (263), `everything-panel.tsx` (439), `search-panel.tsx` (366), `status-bar.tsx` (119), `tool-bar.tsx`, `workspace-tools.ts`.

- **Global column (rail):** workspace chips (open set) and a switcher with a dropdown of the 5 most recent projects plus "Open folder…". Context menu on chips.
- **Views:**
  - `everything` (default): recent documents across open workspaces, `recent-documents` collection, 100 stored, plus sessions and prompts with attention marks from `seen` and `utils/attention.ts`.
  - Per-workspace tools `files | search | git | sessions`. `lastTool` is a per-workspace instance that remembers the last tool while the workspace is open.
- **Resize:** 10–26 rem, default 15 (`hooks/use-sidebar-resize.ts`). Collapse uses a tween (`use-sidebar-collapse-tween.ts`) and `Mod+\`. RTL mirrors the sidebar side, from project settings `direction`.
- **Ownership:** git and sessions views belong to other spikes. This spike delivers the frame plus Everything, Files and Search.
- **GPUI:** a `Sidebar` view with an `enum SidebarView`, a `h_resizable` left pane, and animation via `with_animation`. **Effort: 1.5 person-weeks.**

---

## 7. Persistence

**Storage:** one SQLite file, `notefig.db`, in `app_data_dir` (`~/Library/Application Support/com.notefig.app/` on macOS; `NOTEFIG_DB_DIR` overrides it for e2e).
- **Desktop:** rusqlite, bundled, in `db_ops.rs`. Commands are `db_execute`, `db_query`, `db_close` and `db_reset`. A `BEGIN` arriving inside an open transaction rolls back the orphaned transaction first. Only `Corrupt` and `NotADatabase` errors trigger recreate.
- **Web:** wa-sqlite over OPFS in a worker (`browser-db.ts`, `@tanstack/browser-db-sqlite-persistence`, OPFSCoopSyncVFS).
- **Schema** is owned by `@tanstack/db-sqlite-persistence-core`. `collection_registry(collection_id → table_name)` maps each collection to its own table with an encoded `key` (`s:<str>`) and a JSON `value`. See `db_ops::read_persisted_number_at`, which Rust uses to read `kv:settings.zoomLevel` before first paint.

**TanStack DB persisted collections (what is stored):**

| Collection id | Row | Owner |
|---|---|---|
| `kv:<namespace>` | `{key, value: json}` | `modules/kv/kv.ts` |
| `open-workspaces` | `{key, path, openedAt, focusedAt}` | workspaces |
| `recent-documents` | `{path, workspaceKey, lastOpenedAt}` (max 100) | recent-documents |
| `seen` | `{id: "task:<id>"\|"document:<path>", lastSeenAt}` | seen |
| `agent-tasks`, `prompt-rounds`, `harnesses`, `usage-buckets`, `usage-limits` | — | agents spike (listed for migration completeness) |

**KV namespaces:**
- `settings`, typed in `hooks/use-app-settings.ts`. Defaults:
  - `theme`: `"dark"`
  - `zoomLevel`: `1`
  - `crashReportingEnabled`: `true`
  - `analyticsEnabled`: `true`
  - `autoUpdateEnabled`: `true`
  - `scratchpadOnStartup`: `true`
  - `dictationEnabled`: `true`
  - `telemetryConsentVersion`: `0`
  - `telemetryInstallId`: `null`
  - `lastSeenVersion`: `null`
  - plus `dictationUsed` and legacy `lastSearch`
- `session` (`lastSearch`)
- `recentProjects` (path → `{name, lastOpenedAt}`)
- `agent` (trust keys, harness selection)
- `harness-probe`, `harness-settings` (legacy)
- `tunnel` (pairing)

**Other state:**
- Window bounds: `tauri-plugin-window-state`, `.window-state.json` in app-data.
- Per-project settings: `metrists.json` in the workspace.
- Scratchpads: `<ws>/.notefig/scratchpads/*.md`.

**GPUI port:**
- **Keep SQLite (rusqlite, bundled)** and read the existing `notefig.db` in place. A `migrate_from_tanstack.rs` reads `collection_registry` and decodes the `s:` keys into our own tables. Use typed tables for open-workspaces, recent-docs and seen, and `kv(namespace, key, json)` for kv. This keeps every user's open workspaces, settings and session on the upgrade.
- **Reactivity** replaces TanStack DB. A `Store<T>` entity holds `Vec<T>` or `HashMap` in memory, loaded **synchronously** at `init`, before the first window. This removes "write before hydration is lost" and every `preload()` wait. Mutations update memory, `cx.notify()`, then write through on the background executor via a single-writer connection (SQLite WAL). Writes are awaitable through `Task<Result<()>>` when durability matters (`recordFocus`).
- **redb/sled are not recommended**: they lose the in-place migration and the wasm story is weaker.
- **Zoom and theme before first paint** are trivial, because the kv is loaded synchronously before `open_window`.
- **Effort: 1.5 person-weeks** (store, kv, three typed collections, migration, corruption-recreate policy).

---

## 8. Themes

- **App tokens** are in `desktop/src/styles.css` (817 lines). They are shadcn HSL triples under `:root` (light) and `.dark`, mapped through Tailwind `@theme inline`:
  - **Core:** `background`, `foreground`, `card(-foreground)`, `popover(-foreground)`, `primary(-foreground)`, `secondary(-foreground)`, `muted(-foreground)`, `accent(-foreground)`, `destructive(-foreground)`, `border`, `input`, `ring`, `radius` (0.5rem; sm/md/lg derived), `chart-1..5`.
  - **Brand:** `brand` (#c56a4a light, #d98a6b dark), `success` (sage #8c8f72 / #a3a68a), `warning` (rust #9e3f2a / #eb6a45), `highlight` (#e8c9b8), `logo`.
  - **Dock:** `dockable-colors-{headers,background,gap,text,selected}`, `dockable-radius` (0), `dockable-gap` (1px).
  - **Tree:** `trees-theme-{sidebar-bg,sidebar-fg,sidebar-border,sidebar-header-fg,list-hover-bg,list-active-selection-bg/fg,input-bg/fg,focus-ring,scrollbar-thumb}` plus `trees-*-override` (font, size, padding, icon width, level gap).
  - **Shimmer:** `shimmer-{angle,color,duration,spread}`.
  - **Fonts:**
    - `font-sans`: Inter, then Rubik for Hebrew and Arabic, then system fallbacks.
    - `font-serif`: Libre Baskerville.
    - `font-mono`: ui-monospace stack.
  - **Scale:** root `font-size: 150%`, a 1.5× UI-scale baseline that all rem sizing keys off.
  - **Texture:** a noise texture overlay (`/textures/noise.svg`, `body::before`).
- **Modes:** `dark | light | system` (`components/theme-provider.tsx`). System follows `prefers-color-scheme` live. The native View → Theme menu emits `theme-changed`, which persists to `settings.theme`. Default is `dark`.
- **`packages/themes/notefig-theme-next`** is the CLI's published-site Next.js theme, **not** the app's. Out of scope.
- **`packages/ui`** holds shadcn-on-Radix primitives: button, button-group, checkbox, dialog, alert-dialog, popover, tooltip, select, dropdown-menu, context-menu, command (cmdk), input, textarea, switch, separator, scroll-area, toolbar, marker, message-scroller, orb-loader (701 lines), voice-wave (223). gpui-component covers all of these except orb-loader and voice-wave, which are custom `canvas`/`paint_path` drawing.
- **GPUI:** a `NotefigTheme` struct (serde, `light` + `dark` from one JSON) that sets gpui-component's `Theme`/`ThemeColor` (it has background, foreground, primary, secondary, muted, accent, border, input, ring, destructive, popover, sidebar.*, tab_bar.*, list.*, and so on) plus our extras (brand, success, warning, highlight, chart) in our own `Global`.
  - `ThemeMode::{Light, Dark}`, with "system" via `window.appearance()` plus `cx.observe_window_appearance`.
  - Zoom 0.75/1/1.25/1.5 maps to `window.set_rem_size(base * zoom)`. That replaces webview zoom and the Rust `restore_zoom_level`.
  - Bundle Inter, Rubik and Libre Baskerville via `cx.text_system().add_fonts`.
  - The noise overlay is an `img()` with tiled SVG or a cached `paint_image`. Check its cost against the perf budget.
- **Effort: 0.75 person-weeks.**

---

## 9. Keyboard shortcuts and command palette

- **Shortcut list:** `components/editor/hotkey-catalog.ts` documents it; each `useHotkey()` (`@tanstack/react-hotkeys`) call site owns its binding.
  - **General:** Mod+K command palette, Mod+P quick switcher, Mod+Shift+, settings, Mod+\ toggle sidebar, Mod+Shift+A sessions sidebar, Mod+Shift+U usage, Mod+Shift+M send feedback.
  - **Tabs:** Mod+W close, Ctrl+Tab and Ctrl+Shift+Tab next/prev, Mod+1…9 select, Mod+[ and Mod+] previous/next pane, Mod+Alt+Arrows focus pane in a direction.
  - **Editing:** Mod+N new scratchpad, Mod+F find in file, Mod+Shift+F find in files, Mod+Z and Mod+Shift+Z undo/redo.
  - **Dictation:** hold Right Alt (mac) or Right Ctrl (`dictationHoldKey()`).
  - **Native menu:** Mod+O open folder, Mod+Q quit.
  - The catalog is described as "becoming user-editable next".
- **Command palette** (`components/editor/command-palette.tsx`, 611 lines; cmdk):
  - Commands: send-feedback, new-scratchpad, new-file, close-file, new-directory, open-folder, close-workspace, undo, redo, search-in-file, search-in-files, toggle-sidebar, toggle-fullscreen, open-settings, open-usage, toggle-theme.
  - Typing shows "quick results" from file search. The quick switcher is Mod+P.
  - Handlers come from `hooks/use-workspace-commands.ts`.
- **GPUI:** `actions!(notefig, [ToggleCommandPalette, QuickSwitcher, OpenSettings, ToggleSidebar, CloseTab, NextTab, …, SelectTab(usize)])`, with `cx.bind_keys([KeyBinding::new("cmd-k", ToggleCommandPalette, Some("Workspace")), …])`. Key contexts (`Workspace`, `FileTree`, `Editor`, `Palette`) give scoping for free.
  - User-editable bindings means loading a keymap JSON into `KeyBinding`s. That is a stretch goal but structurally free.
  - The palette is a gpui-component `Popover`/modal with an `Input` and a `List` plus a fuzzy matcher. Use `nucleo` or port `utils/file-score.ts` to keep the ranking identical.
  - Menus use `cx.set_menus`: File (Open Folder…, Quit), Edit (OS-predefined undo, redo, cut, copy, paste, select all, via `MenuItem::os_action`), View → Theme (Light/Dark/System) and Zoom Level (75–150%).
  - **Hold-key dictation is a risk.** GPUI's `Modifiers` does not distinguish left from right. It needs `ModifiersChangedEvent` plus a platform check, such as `NSEvent.keyCode` 61 for right option on macOS, through a small objc2 hook.
- **Effort: 1.5 person-weeks.**

---

## 10. Titlebar and window chrome

**Window config today** (`tauri.conf.json`):
- 1440×900, minimum 1000×700.
- `titleBarStyle: Overlay`, `hiddenTitle`, `trafficLightPosition {x:21, y:29}`.
- `visible: false` until the frontend shows the window.
- `dragDropEnabled: false`, `zoomHotkeysEnabled`.
- Windows: `decorations: false` (`tauri.windows.conf.json`).

**`components/titlebar.tsx` (438 lines):**
- On macOS it computes header geometry from the lights and asks Rust `place_traffic_lights(centerY)` (`traffic_lights.rs`, objc2/AppKit). That pins the button cluster's vertical centre on the header midline (12+1+18 = 31 pt) and returns the measured rect, because macOS 26 Tahoe uses 14 pt buttons on a 23 pt pitch, versus 12/20 on 11–15. The pin is re-applied on resize, scale, theme and focus events.
- Windows gets an inline minimize/maximize/close cluster.
- `data-tauri-drag-region` marks drag areas. The shell layout is "floating cards" with a 12 px padding.

**GPUI:**
- `WindowOptions { titlebar: Some(TitlebarOptions { appears_transparent: true, traffic_light_position: Some(point(px(x), px(y))) }), window_min_size, window_bounds: restored, show: false→true after first frame, window_decorations: Some(Client) on Linux }`.
- GPUI positions the traffic lights itself in its `NSWindow` subclass. Verify on Tahoe; if it is off, keep a port of `traffic_lights.rs` (188 lines, objc2) driven from `observe_window_bounds` and `observe_window_appearance`.
- Drag regions: `WindowControlArea::Drag` on header divs (it also gives Windows snap layouts via `Max`/`Min`/`Close` areas), plus `window.start_window_move()` on Linux.
- gpui-component's `TitleBar` component handles cross-platform controls.
- Window state: persist bounds and display in kv `window` on `observe_window_bounds` (debounced), and restore at open. This replaces `tauri-plugin-window-state` and the `com.metrists.dev` migration in `main.rs`.
- **Effort: 1.25 person-weeks** (macOS, Windows and Linux client-side decorations).

**Menu-bar status item** (`app_status.rs`, 272 lines; `hooks/use-app-status.ts`):
- The model is published by the frontend: `AppStatus{attention, sections[entries{id,label,detail,mark}], actions}`.
- Rust draws a template icon with an attention dot and a native menu using the row glyphs (`icons/menu`).
- Picking an item brings the window forward and emits `app-status-activated(id)`.
- **GPUI:** GPUI has no tray API. Use the `tray-icon` and `muda` crates on the main thread. On macOS, AppKit is already running GPUI's loop, so create the item after `App::run` launches and route `MenuEvent` through a channel to `cx.spawn`. **Effort: 0.75 person-weeks; risk is low to medium.**

---

## 11. Settings

`components/editor/settings-modal.tsx` (734 lines): one scroll container with a scroll-spy rail. `?settings=<section>` is the open state. Sections:

- **general:**
  - Language select (en, es, fr, de, ja, ar, he). Only `en` resources exist in `utils/intl.ts` (782 lines, i18next).
  - Text direction (writes project settings).
  - Scratchpad on startup.
  - Dictation toggle.
  - Debug mode.
  - Advanced: release notes, automatic updates and update status, send feedback.
- **appearance:** theme.
- **hotkeys:** the catalog rendered.
- **harnesses:** agents spike.
- **usage:** usage spike / agents.
- **privacy:** crash reporting and analytics switches, or "disabled in build".

**GPUI:**
- Settings is a modal view backed by `Kv::settings` (a typed `AppSettings` struct with serde defaults, merged like `mergeWithDefaults`).
- gpui-component has `Switch`, `Select` and `Input`, plus a newer `Settings` page component; check the version.
- i18n: `rust-i18n` or `fluent`. Port the en strings from `intl.ts` with a script.
- **Effort: 1 person-week.**

---

## 12. Telemetry (PostHog)

`desktop/src/telemetry/telemetry.ts`, `scrub.ts`, `events.ts`; `modules/telemetry/telemetry.ts`; `components/telemetry-consent-dialog.tsx`.

**Behaviour today:**
- `VITE_POSTHOG_KEY` plus `VITE_POSTHOG_HOST` (default `us.i.posthog.com`). A build without a key, or a test backend, means telemetry is never sent.
- **Tiers:** `usage`, `crash`, and `meta` (the consent answer itself).
- Events buffer while consent is pending (cap 25) and flush through the tier filter after `configureTelemetry`.
- `posthog-js` is loaded dynamically only when a tier is enabled.
- **Consent:**
  - A first-run dialog is shown when `telemetryConsentVersion < CURRENT (1)`.
  - `telemetryInstallId` is created lazily, only if a tier is on.
  - `app_opened` fires after configure.
- **Errors:** global error and unhandled-rejection handlers, deduped within 5 s, with paths and secrets scrubbed (`scrub.ts`).
- **DB errors** are also captured (`tauri-db.ts`, `browser-db.ts`).

**GPUI:**
- A `Telemetry` global with the same tier, buffer and consent state machine.
- Transport is a plain HTTPS `POST {host}/batch/` (or `/i/v0/e/`) via `reqwest` or GPUI's `http_client` on the background executor. The official `posthog-rs` crate covers capture; we need batching and `$exception` shape anyway. Batch every 30 s and on quit.
- **Crashes:**
  - A `std::panic::set_hook` captures `$exception` with a scrubbed backtrace.
  - Native crashes (segfaults in Metal or ONNX) need `minidumper` plus `crash-handler`, or `sentry` with minidumps, uploaded on next launch. That is new capability: the webview never crashed the process.
- `scrub.rs` ports `scrub.ts`. Keep the key out of the binary for forks (`option_env!`).
- **Effort: 1 person-week**, plus 0.5 for minidumps.

---

## 13. Updater

**Today:**
- `tauri-plugin-updater` with a minisign pubkey in `tauri.conf.json`, endpoint `github.com/notefig/notefig/releases/latest/download/latest.json`, `createUpdaterArtifacts`.
- `tauri-plugin-process::relaunch`.
- UI is `components/app-updater.tsx` (480 lines). It checks on mount, on focus (10 min stale time) and every 15 min, through a TanStack query.
- Toasts persist until acted on. There is a download-progress toast, then "Restart".
- `autoUpdateEnabled` setting.
- The release-notes tab opens once per version (`hooks/use-release-notes-on-update.ts`, `lastSeenVersion`).
- Web uses a "refresh" flow.
- Release is `release-desktop.yml`, which publishes the GitHub Release, binaries and Cloudflare Pages.

**Rust options:**

| Option | Notes |
|---|---|
| **`cargo-packager-updater`** (CrabNebula, from Tauri's updater lineage) | Same minisign plus JSON-manifest model, so we can **keep the existing key and `latest.json` shape**. Pairs with `cargo-packager` for .app/.dmg/NSIS/MSI/AppImage/deb bundling. **Recommended.** |
| `velopack` | Rust-native, delta updates, cross-platform installers, own release format. A good long-term choice, but it means a new release pipeline. |
| Sparkle (macOS via FFI) | Mac only. |
| Zed's `auto_update` | GPL-3.0; don't copy it. |

**Migration bridge:** the last Tauri release's updater can install the GPUI build.
- On macOS, Tauri's updater replaces the `.app` bundle from a signed `.app.tar.gz`. Ship the GPUI `Notefig.app` with the same bundle id `com.notefig.app`, signed with the same key, in that feed.
- On Windows, the Tauri updater runs whatever NSIS/MSI it is pointed to.

This lets existing users cross over without a manual download. Signing and notarization stay in CI: keep `Entitlements.plist` (allow-jit for the Node ACP sidecar, audio-input) and Info.plist `NSMicrophoneUsageDescription`.

**Effort: 1.5 person-weeks** (updater, packaging, CI, crossover test).

---

## 14. Feedback, tunnel, dictation

### Feedback

`modules/feedback/{feedback.ts,images.ts,react.tsx,message-editor.tsx}`.
- `core.feedback` exposes `available` (only when the build has a support URL), `open`/`close`, `addImage`, `releaseImages` and `send`.
- `send` posts `{message markdown, version, OS, images as attachment:<id>, optional debugReport ≤ 49k chars}` to `${supportUrl}/v1/feedback`, with a 30 s timeout. Results are `sent | rate-limited | failed`. The worker files the feedback into Linear Triage.
- The message editor is a small TipTap with the markdown schema.
- **GPUI:** a multi-line `Input` (or the editor spike's widget once it exists), image paste via `ClipboardItem` images, encoding with the `image` crate (shrink, PNG/WebP), and a `reqwest` multipart post. **0.5 person-weeks.**

### Tunnel

`modules/agents/tunnel/*`, `components/tunnel/*`. It is **web-only**: the browser connects to a `notefig agent` worker (CLI) over a WebSocket with a pairing handshake and an encrypted frame mux (acp/mcp/ctl). The protocol is in `shared/src/tunnel/PROTOCOL.md`. A deep link `/pair#<code>` opens the pair dialog. On desktop the module boots but does nothing.
- **GPUI:** only needed for the wasm build: `web-sys` WebSocket plus a crypto port. **Defer** with wasm. The protocol spec makes a Rust client straightforward (about 1.5 person-weeks when wasm happens).

### Dictation

`packages/dictation` (2.1k lines) and `desktop/src/modules/dictation/dictation.ts`.

**Today:**
- **Model:** NVIDIA Parakeet TDT-CTC 110M, int8, sherpa-onnx export, CC-BY-4.0. It is pinned and chunked into `public/dictation/` (24 MiB chunks plus a sha256 manifest) by `scripts/fetch-dictation-model.mjs`.
- **Inference:** onnxruntime-web 1.30 in a worker (`engine/worker-engine.ts`), NeMo log-mel features (`log-mel.ts`, 168 lines), greedy CTC (`ctc.ts`, 46).
- **Segmentation:** a pause-based segmenter (`segmenter.ts`).
- **Audio:** an AudioWorklet mic (`microphone.ts`) resampled to 16 kHz mono.
- **Interaction:** hold-to-talk (`AltRight` on mac, else `ControlRight`), Escape cancels. Live partial re-decode while the user speaks.
- **Warm-up:** the model warms 5 s after boot if the user has dictated before.
- **Editor contract:** `target.ts` (`fitDictation`); editors attach via the TipTap extension in `@notefig/widgets`.

**Native Rust:**
- `ort` (onnxruntime bindings, CoreML/DirectML execution providers) loads the **same model file**, so its WER is already validated.
- Port log-mel to `realfft`, CTC decode and the segmenter. That is about 400 lines, straightforward.
- Mic via `cpal` (CoreAudio, WASAPI, ALSA/Pulse) plus `rubato` resampling. Inference runs on a dedicated thread.
- Alternative: `sherpa-rs` (bindings to sherpa-onnx, which supports this exact model family including features). It is less code but a heavier C++ build.
- Pure-Rust `tract-onnx` would also run on wasm, but int8 op coverage for Parakeet is unverified. Risk.
- **Model distribution:** bundle it in app Resources (about 120 MB int8, check the manifest size), or download on first enable with sha256 check. The second option is the better installer size.
- Native mic permission needs the existing Info.plist string and entitlement, plus `AVCaptureDevice.requestAccess` handling.

**Effort: 2.5 person-weeks. Post-MVP.**

---

## 15. Tauri command, plugin and capability inventory

Registered in `src-tauri/src/lib.rs::register_handlers`: 27 commands, plus the `--mcp-stdio-relay <port>` CLI mode in `main.rs`.

| Command | File | Rust/GPUI equivalent |
|---|---|---|
| `read_directory(path, recursive, include*, ignore)` | fs_ops.rs | `Fs::read_dir`/`walk`, the same code minus serde/IPC, using `walkdir_utils.rs` (409 lines; circular-symlink and hidden checks) |
| `create_directories`, `delete_directories(recursive)`, `move_directory` | fs_ops.rs | `Fs` trait methods (std::fs on the background executor) |
| `read_file`, `read_binary_file`, `write_file` (atomic, registers app write plus md5), `write_binary_file` | fs_ops.rs | `Fs::load`, `load_bytes`, `save` (keep temp-file-then-rename and `register_app_write`) |
| `create_files`, `delete_files`, `move_file`, `copy_file`, `check_exists`, `get_metadata` | fs_ops.rs | `Fs` methods. Deletion should consider `trash` (crate `trash`) as an improvement. |
| `start_watching_metadata(paths, watchId, ignoreDirs, ignoreExts)`, `start_watching_content(paths, watchId)`, `stop_watching` | file_watcher.rs (1241 lines) | `Watcher` owned by `WorkspaceFiles`: notify 6 plus debouncer-full 100 ms. Emits `fs-metadata-changed`/`fs-content-changed`, which become channel → entity update. Watch ids are dropped. |
| `search_content` | search.rs (355) | Same `grep`/`grep-regex` code, streaming results into the search panel via a channel, which is better than today's batch |
| `spawn_agent`, `write_agent_stdin`, `kill_agent`, `run_shell_command` | agent_proc.rs (1117; killpg on unix, Job Objects on Windows, live registry PATH) | **Agents spike.** `async-process` with the same process-group and job teardown, plus `kill_all_agents` on quit (`cx.on_app_quit`). |
| `start_mcp_relay`, `stop_mcp_relay`, `write_mcp_line` | mcp_bridge.rs (446) | **Agents spike.** Keep the `--mcp-stdio-relay` mode in the same binary. |
| `pull_stream_lines` | line_stream.rs (480) | Not needed: it exists only to batch IPC. Channels replace it. |
| `db_execute`, `db_query`, `db_close`, `db_reset` | db_ops.rs (699) | Direct rusqlite in `Db`. Keep the orphan-BEGIN and corrupt-only recreate policy. |
| `place_traffic_lights(centerY)` | traffic_lights.rs (188) | GPUI `traffic_light_position`, or keep this objc2 code |
| `publish_app_status(status)` | app_status.rs (272) | `tray-icon` plus `muda` |

**Plugins** (`main.rs`, `Cargo.toml`):

| Plugin | Replacement |
|---|---|
| `tauri-plugin-dialog` (`open({directory})`) | `cx.prompt_for_paths(PathPromptOptions{directories:true, files:false, multiple:false})`, native in GPUI. `rfd` is only needed for wasm or extra dialogs. |
| `tauri-plugin-fs` | Not needed; direct std::fs |
| `tauri-plugin-opener` (`openUrl`, including `x-apple.systempreferences:`) | `cx.open_url` |
| `tauri-plugin-updater` | `cargo-packager-updater` |
| `tauri-plugin-process` | `cx.restart()` (GPUI has a restart API) |
| `tauri-plugin-window-state` | Own bounds persistence |
| `tauri-plugin-shell` (`open: true` in config only) | Not needed |
| `tauri-nspanel` (macOS) | Used for the status-item panel; replaced by `tray-icon` |
| Tauri `tray-icon` feature | `tray-icon` crate |
| `protocol-asset` (`convertFileSrc`, scope `$HOME/**`…) | Not needed: GPUI `img(path)` loads from disk directly. `resolveAssetUrl` becomes a path. |

**Capabilities** (`capabilities/default.json`): fs scope `$HOME`, `$DOCUMENT`, `$DOWNLOAD`, `$DESKTOP`; dialog, updater, process and opener defaults; webview zoom; window minimize, toggle-maximize, close, start-dragging and is-maximized; window-state. **All of this disappears.** A native process has no IPC ACL. Security posture changes from "webview sandboxed by capabilities" to "whole process trusted", which is acceptable because there is no remote content. The CSP is already `null`.

**Menus** (`main.rs::create_menu`):
- File: Open Folder… (Mod+O, emits `folder-selected`), Quit.
- Edit: predefined undo, redo, cut, copy, paste, select all.
- View → Theme (Light/Dark/System, emits `theme-changed`) and Zoom Level (75/100/125/150%, emits `zoom-changed`).

**Lifecycle hooks:**
- Restore zoom from SQLite before paint.
- Re-pin the traffic lights on Resized, ScaleFactorChanged, ThemeChanged and Focused.
- `RunEvent::Exit` calls `kill_all_agents`.
- App-data migration from `com.metrists.dev`.

**Deep links:** **none registered on desktop**. There is no `tauri-plugin-deep-link`. The only "deep link" is the web `/pair#<code>` route. `notefig://widget-context` is an MCP resource URI, not an OS scheme.

**Sidecar:** `externalBin: binaries/claude-agent-acp` (Node). Bundled via `cargo-packager` resources (agents spike).

---

## 16. Perf SLOs

`desktop/tests/perf/slos.json`: enforced, 10% regression tolerance. Baselines are on the `perf-baselines` branch at `4a6555c1`, p95, in ms.

| id | Title | Current p95 (ms) | GPUI expectation |
|---|---|---|---|
| `workspace-open` | Open a 20k-file workspace until a file is interactive | **1629.5** | **Shell-owned.** A parallel `ignore` walk of 20k entries takes tens of ms on SSD. The target is under 300 ms to tree, and file interactivity depends on the editor spike. |
| `caret-move` | Caret move, 8k-line doc | 27.4 | editor spike |
| `select-all` | Select all, 8k-line doc | 264 | editor spike |
| `select-all-caret-move` | Caret move out of select all | 151.7 | editor spike |
| `input-delete` | Type and delete, 8k-line doc | 58.8 | editor spike |
| `widget-input` | Prompt widget: type and delete | 69.7 | editor/agents |
| `widget-caret-move` | Prompt widget: caret move | 21.7 | editor/agents |

**Measurement today:** Playwright over a production build against the release `test-shim` crate. Latency is keydown `timeStamp` to the next painted frame (`tests/perf/latency.ts`), plus long tasks of 50 ms or more.

**GPUI needs a new harness:**
- Drive the app with `TestAppContext`/`VisualTestContext` for logic timings.
- For real frame latency: an env flag that injects synthetic key events via `window.dispatch_keystroke`, and times from dispatch to `on_next_frame`/present callback.
- Record to the same `perf-results` JSON schema so `scripts/perf-report` and `perf-compare` keep working. Never edit baselines by hand (AGENTS.md).

**Effort: 1 person-week.**

---

## 17. Rust/GPUI port

### Crates

| Concern | Crate(s) | Notes |
|---|---|---|
| UI | `gpui` (Zed, Apache-2.0), `gpui-component` (longbridge, Apache-2.0): Input, List, Tree, Dock/Resizable, TabBar, Popover, ContextMenu, Dialog, Notification (toasts), Switch, Select, Kbd, TitleBar, Theme | Pin to a git rev; gpui has no stable crates.io cadence. "gpui-kit": evaluate alongside, without assuming overlap. |
| Fs | std::fs on the background executor; `ignore` (parallel walk); `walkdir` (existing); `trash`; `dunce` (Windows canonical paths); `md-5` (keep the hash compatible with `compute_content_hash`) | Port `fs_ops.rs` and `walkdir_utils.rs` almost verbatim |
| Watcher | `notify` 6/7 plus `notify-debouncer-full` | Reuse `file_watcher.rs` logic |
| Search | `grep`, `grep-regex`, `grep-searcher` (existing) | Stream results |
| Fuzzy | `nucleo-matcher`, or a port of `utils/file-score.ts` | Keep the ranking stable |
| Storage | `rusqlite` (bundled), with `sqlite-wasm-rs` on wasm | Migrate the TanStack tables in place |
| Paths and dirs | `directories` (`ProjectDirs::from("com","notefig","app")`). It must resolve to Tauri's `app_data_dir` (`~/Library/Application Support/com.notefig.app`) so the db is found. | Verify path parity on Windows (`%APPDATA%\com.notefig.app`) and Linux |
| Dialogs | GPUI `prompt_for_paths` and `window.prompt`; `rfd` as fallback or wasm | |
| Open URL, restart | GPUI `open_url`, `restart` | |
| Tray | `tray-icon`, `muda` | macOS first |
| Updater, packaging | `cargo-packager`, `cargo-packager-updater` (minisign, existing key); alternative `velopack` | |
| HTTP | `reqwest` (rustls) or gpui `http_client` | Telemetry, feedback, update |
| Telemetry, crash | Own PostHog client (or `posthog-rs`); `minidumper` plus `crash-handler`, or `sentry` | |
| i18n | `rust-i18n` or `fluent-bundle` | |
| Dictation | `ort` (or `sherpa-rs`), `cpal`, `rubato`, `realfft` | wasm: `tract-onnx` or JS onnxruntime-web via `wasm-bindgen` |
| Serde | `serde`, `serde_json` | `LayoutNode` JSON-compatible |

### Proposed crate layout

```
crates/
  notefig-core      # workspace registry, async step lists, Platform traits (Fs, Db, Dialogs, Proc, Updater), events
  platform-native   # RealFs, watcher, search, sqlite, dialogs, tray, updater
  platform-web      # (later) OPFS/FSA fs, sqlite-wasm, polling watcher
  store             # Store<T> entities, kv, migrations
  files             # WorkspaceFiles, FileTreeModel, file search
  layout            # LayoutNode, reducer, tab ids (pure, no gpui dependency, so it unit-tests fast)
  shell             # Workspace view, sidebar, dock, titlebar, palette, settings, welcome, theme
  telemetry
  dictation
  app               # main.rs: init order (the composition root)
```

The Fallow boundary rules ("only app-core imports adapters") become crate dependency rules. Only `app` depends on `platform-native` or `platform-web`, so the compiler enforces the boundary.

### wasm story per surface

GPUI itself on `wasm32` is the gating unknown. As of this writing, GPUI ships Metal (macOS), DirectX (Windows) and Blade/Vulkan (Linux) renderers and has no first-party web platform. Any web build depends on an upstream or community WebGPU/WebGL platform and a browser event loop. **Treat web as a separate track, gated on that.** Keep every non-UI crate wasm-clean from day one: no `std::fs` outside `platform-native`, `Fs`/`Db` behind traits, and a CI job that runs `cargo check --target wasm32-unknown-unknown` on core, store, files and layout.

| Surface | Native | wasm |
|---|---|---|
| fs (user folder) | std::fs | File System Access API (`showDirectoryPicker`, Chromium only) via `web-sys`. Handles persist in IndexedDB, as today (`notefig-fs-handles`). Re-grant needs a user gesture, so `request_workspace_access` must be called from an input handler. |
| fs (app-owned, demo) | — | OPFS (`navigator.storage.getDirectory`; sync access handles in a worker), or the existing IndexedDB `metrists-fs` layout for continuity |
| watcher | notify | Polling at 5 s metadata and 3 s content (port `browser-file-watcher.ts`) plus `BroadcastChannel` across tabs (still a TODO in `base-browser-adapter.ts`) |
| search | grep crates | grep-regex compiles to wasm; walk via the fs trait in a worker |
| db | rusqlite | `sqlite-wasm-rs` with OPFS SAH-pool VFS in a worker (current: wa-sqlite OPFSCoopSyncVFS). Same schema, so the same migrations. |
| dialogs | GPUI native | `showDirectoryPicker`; text prompt in-app |
| proc / agents | child processes | None. Tunnel to `notefig agent` (WebSocket) is the transport. |
| updater | packager-updater | "refresh" flow (new deploy → reload toast) |
| telemetry | reqwest | `fetch` (reqwest's wasm backend) |
| dictation | ort plus cpal | `getUserMedia` plus AudioWorklet, with onnxruntime-web via JS interop or `tract` |
| tray, menus, chrome | tray-icon, set_menus | none (in-app menus only) |

### Risks (ranked)

1. **GPUI wasm**: no first-party web target. The marketing site (`packages/marketing/site/main.tsx` boots `runtimeModules()` in the browser) and web build would stay on React until it exists, which means maintaining two shells. **High.**
2. **Licensing.** Zed's `workspace`, `project_panel`, `command_palette`, `auto_update`, `settings`, `fs` and `editor` crates are **GPL-3.0** (gpui itself is Apache-2.0). Reading them is fine. Copying code into Notefig is not, unless Notefig goes GPL. Budget for writing the dock, tree and palette ourselves or using gpui-component. **High if ignored.**
3. **GPUI API churn and documentation.** gpui is pre-1.0, the API changes often (the `App`/`Context<T>`/`Window` split of 2025 is one example), and docs are thin. Pin a rev and plan quarterly bumps. **Medium.**
4. **Dock and tree parity.** Drag-to-split with 4 edges, tab drag between windows, tree inline edit, and drag into tabs are a lot of bespoke interaction. dnd-kit and @pierre/trees give these today. **Medium.** Mitigation: the DockArea-vs-own-model sub-spike in the first week.
5. **The editor spike gates everything visible.** The shell can render file tabs with a placeholder `TextView`, but MVP usefulness needs the markdown editor. **Medium** (cross-spike).
6. **Data migration.** Reading TanStack's SQLite layout (`collection_registry` plus encoded keys) is undocumented internals of `@tanstack/db-sqlite-persistence-core`. Mitigation: fixture a real `notefig.db` from a current build and test the importer against it. **Medium-low.**
7. **Platform-specific gaps.**
   - Left/right modifier distinction for hold-to-talk.
   - The tray on the GPUI run loop.
   - Traffic-light placement on macOS 26.
   - Linux client-side decorations and Wayland drag.
   - **Low to medium** each.
8. **Rendering cost of the visual style.** The noise texture overlay, "floating cards", shimmer and orb-loader animations need GPU paths. GPUI renders these cheaply, but the orb-loader (701 lines of canvas or CSS) needs a hand port. **Low.**
9. **Crash surface.** A native process crash (GPU driver, ONNX) now takes the whole app down, and there is no webview isolation. Crash reporting with minidumps becomes required, not optional. **Medium.**
10. **Testing parity.** Playwright e2e (`tests/e2e`) and the test-shim don't carry over. A new `gpui::test` suite plus a smaller set of OS-level UI tests are needed. **Medium** effort, already in the estimates.

### MVP subset (macOS, shell slice)

**Goal:** a signed macOS app that opens and restores workspaces, browses, edits and saves files (with the editor spike's view), splits and persists tabs, and auto-updates, reading the user's existing `notefig.db`.

| # | Item | Person-weeks |
|---|---|---|
| 1 | Kernel: `app` init order, `WorkspaceRegistry` with async open/focus/enter/close step lists, ticket/supersede, events | 1.5 |
| 2 | Platform-native: `Fs` (ported fs_ops and walkdir_utils), watcher (ported file_watcher), search (ported), `FakeFs` for tests | 1.5 |
| 3 | Store: SQLite, sync-load `Store<T>`, kv, open-workspaces, recent-docs, seen, TanStack importer, corrupt-recreate | 1.5 |
| 4 | Workspaces UI: welcome, recent projects, open-folder dialog, switcher, close dialog, access-error recovery | 1.0 |
| 5 | WorkspaceFiles: walk, metadata and content, watcher apply, catch-up, echo suppression, ignore, project settings, scratchpads plus landing | 2.0 |
| 6 | File tree: virtualized, 3 sorts, expansion memory, inline rename and create, context menu, delete confirm, drag-move (drag into tabs is in item 7) | 2.5 |
| 7 | Tabs plus dock: layout model port, splits, resize, drag tabs to edges and between windows, drag tree rows in, keyboard pane focus, session persistence plus `lastSearch` import | 3.0 |
| 8 | Sidebar frame plus rail plus Everything, Files and Search views, resize and collapse | 1.5 |
| 9 | Theme (tokens, light/dark/system, fonts, zoom as rem size) | 0.75 |
| 10 | Actions and keymap, native menus, command palette plus quick switcher | 1.5 |
| 11 | macOS window chrome (traffic lights, drag regions, bounds restore) | 0.75 |
| 12 | Settings modal (general, appearance, hotkeys, privacy, updates) plus i18n scaffolding | 1.0 |
| 13 | Updater plus cargo-packager, signing and notarization CI, crossover from the Tauri feed | 1.5 |
| 14 | Telemetry plus consent plus panic capture | 1.0 |
| 15 | Perf harness for `workspace-open` plus the latency probe, compatible with the perf-results schema | 1.0 |
| | **MVP total** | **about 22.5 person-weeks** |

**After MVP:**

| Item | Person-weeks |
|---|---|
| Windows and Linux chrome plus packaging | 1.5 |
| Menu-bar status item | 0.75 |
| Feedback dialog | 0.5 |
| Minidump crash reporting | 0.5 |
| Dictation native | 2.5 |
| Release-notes tab | 0.25 |
| Debug panel (`debug-panel.tsx`, 1034 lines; subset) | 1.0 |
| **Desktop parity subtotal** | **about 7 person-weeks** |
| wasm platform crate plus tunnel client (gated on GPUI web) | 4–6 person-weeks after GPUI web exists |

**Shell-slice desktop parity: about 30 person-weeks** for one experienced Rust/GPUI engineer, or about 4 months with 2 engineers working in parallel on items 1–3 versus 6–9. This excludes the editor, agents and git spikes, and the first 2–3 weeks of GPUI ramp-up for engineers new to it.

### Suggested first two weeks (de-risking order)

1. A `layout` crate with the reducer ported, plus a throwaway dock render with drag-to-split. Decide between DockArea and our own model.
2. An `Fs` plus watcher port and a `uniform_list` tree over a 20k-file fixture. Measure walk-to-first-paint against the 1629 ms baseline.
3. A `store` importer run against a real `notefig.db` copied from a current install.
4. A window with traffic lights on macOS 26, plus a `tray-icon` smoke test on the GPUI run loop.
5. A `cargo check --target wasm32-unknown-unknown` CI job on the non-UI crates.
