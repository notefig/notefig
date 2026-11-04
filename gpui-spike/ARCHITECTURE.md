# Notefig on GPUI — architecture

The GPUI app is a **1:1 port of the TS desktop app's architecture**, not a
rewrite of its behaviour into a new shape. Every TS module under
`packages/desktop/src/modules/<name>/` becomes one Rust crate under
`crates/modules/<name>/`. Every group of TS views under `components/` becomes
one view crate under `crates/views/<name>/`. The TS kernel `@notefig/core`
becomes `crates/core`. The TS source is the spec: port its behaviour, its API
shape and its tests. Diverge only where Rust or GPUI forces it, and say so in a
comment.

License: GPL-3.0-or-later. Reading and adapting Zed's GPL crates is allowed
(`workspace`, `project_panel`, `editor`, `agent_ui`, `acp_thread`, `markdown`, `ui`).

## Layout

| path | role | TS counterpart | gpui? |
|---|---|---|---|
| `crates/core` (`notefig-core`) | kernel: `Module`, `Service`, `Core`, hooks, workspace lifetime | `packages/core` | no |
| `crates/platform` (`notefig-platform`) | the platform service's surfaces, plus `fake` for tests | `adapters/platform-adapter.interface.ts` | no |
| `crates/platform-native` | desktop platform: fs, watcher, trash, search, db | `adapters/tauri-adapter.ts` + `src-tauri` | no |
| `crates/modules/<name>` (`notefig-<name>`) | one TS module each | `modules/<name>/` | **no** |
| `crates/ui` (`notefig-ui`) | GPUI glue: core global, `observe`, executor, theme tokens, primitives, script driver | `@notefig/core/react`, `components/ui`, `styles.css` | yes |
| `crates/views/<name>` (`notefig-view-<name>`) | views | `components/…` | yes |
| `crates/app` (`notefig-desktop`, bin `notefig`) | composition root `app_core.rs` + `main.rs` | `core/app-core.ts`, `main.tsx`, `App.tsx` | yes |
| `crates/markdown-editor` | the WYSIWYG editor (ProseMirror-shaped) | TipTap + `components/editor/tiptap-*` | yes |
| `crates/notefig-agent` | ACP client, harness processes, app MCP server and relay | `packages/agent`, `modules/agents/*transport*` | no |
| `crates/notefig-history` | checkpoint repo on gix | `modules/history`, isomorphic-git | no |
| `crates/notefig-workspace` | **legacy**: fs helpers, moved into `platform-native` and `modules/files` | — | no |
| `crates/notefig-app` (bin `notefig-legacy`) | **legacy** monolithic shell from the first spike. Mine it for working code, then leave it | — | yes |

Module crates never depend on gpui, so they stay usable on the web and in the
CLI. A module's React hooks (`react.ts`) become the view crate's job: a view
reads module state and calls `notefig_ui::observe` to re-render.

## The kernel (`notefig-core`)

It follows `packages/core/src/create-core.ts` exactly. Its tests in
`crates/core/src/tests.rs` are the TS tests.

```rust
pub struct FilesModule;                       // defineModule({ name: "files", … })
impl Module for FilesModule {
    const NAME: &'static str = "files";
    type Api = FilesApi;                      // CoreModules.files
    type Workspace = WorkspaceFiles;          // WorkspaceModules.files
    fn needs() -> Vec<ModuleRef> {            // needs: [kvModule, platformModule]
        vec![ModuleRef::of::<KvModule>(), ModuleRef::service::<PlatformService>()]
    }
    fn register(ctx: &ModuleContext) -> FilesApi { create_files(ctx.service::<PlatformService>()) }
    fn boot(api: &Rc<FilesApi>, ctx: &ModuleContext) -> Option<Subscription> { … }
    fn workspace() -> Option<WorkspacePart<Self>> {
        Some(WorkspacePart::new(|ctx, api| Ok(create_workspace_files(ctx.workspace(), …)))
            .needs(vec![ModuleRef::of::<KvModule>()])
            .dispose(|instance, ws, api| async move { instance.stop(); Ok(()) }.boxed_local()))
    }
}
```

- `ctx.use_::<KvModule>()` is `ctx.use("kv")`. `ctx.service::<PlatformService>()`
  is `ctx.use("platform")`. `ctx.use_workspace::<KvModule>()` is
  `ctx.useWorkspace("kv")`. Using something not in `needs` panics, as TS throws.
- `core.use_::<M>()` is `core.<name>`. `core.workspace(path)` returns a
  `WorkspaceHandle` with `open()`, `focus()`, `close()` and `get::<M>()`.
- **Hooks** are typed marker types, declared next to the module that
  announces them (the Rust form of widening `CoreHookMap`):
  ```rust
  pub struct FilesChanged;
  impl Hook for FilesChanged { const NAME: &'static str = "files:changed"; type Payload = FilesChangedEvent; }
  ctx.hooks().emit::<FilesChanged>(event);
  let sub = ctx.hooks().on::<FilesChanged, _>(|e| { … });  // returns (), Result, or a boxed future
  ```
  Core's own hooks: `CoreBooted`, `CoreShutdown`, `WorkspaceOpened`,
  `WorkspaceFocused`, `WorkspaceEntered`, `WorkspaceClosing`.
- **Unsubscribing:** `Subscription` is RAII, the TS `() => void`. `boot`
  returns one, which may be `Subscription::join(vec![…])`. A per-workspace
  listener is kept on the instance and dropped in `dispose`.
- **Async:** single-threaded, like JS. Futures are `!Send` and run through the
  `Executor` that core hands out (`ctx.executor()`, `core.executor()`):
  `spawn_local`, `timer`, and `blocking(|| …)` for disk or CPU work off the
  main thread. Return `LocalBoxFuture<'static, T>` from async APIs, which is
  `Promise<T>`.
- **Observable state:** a module that holds state a view renders exposes
  `subscribe(listener) -> Subscription` and synchronous getters, the
  `useSyncExternalStore` shape. Use `notefig_core::Listeners` for the
  listener list. There are no globals and no module-scope registries: state
  belongs to the module that owns it and is reached through core.
- **Factories:** each entity is built by a factory from what it is handed
  (`create_kv(db)`, `create_workspace_files(deps)`). The module calls that
  factory, and so do its tests. There are no module mocks.

**The reference module is `crates/modules/kv`.** Copy its shape: `lib.rs`
holds the module marker and the public API, other files are private, and
`tests.rs` ports the TS tests.

## Platform (`notefig-platform`)

`Platform { fs, db, ui, app_data_dir }` is the TS `IPlatformAdapter`. Modules
take it with `ctx.service::<PlatformService>()` and never touch `std::fs`, a
process or a dialog directly. Paths are absolute and native, as in TS.
`notefig_platform::fake::FakePlatform` gives tests an in-memory fs (with
`external_write`, `external_delete` and `external_rename` to simulate other
writers), db and ui. The TS `ProcessSurface` is not ported: the agents module
uses `notefig-agent`'s process host directly. That is a known deviation, and a
transport seam remains for the web.

## Views (`crates/views/*`, `notefig-ui`)

- `cx.core()` (`notefig_ui::CoreExt`) is `useCore()`.
- To read module state and re-render when it changes:
  ```rust
  self._sub = notefig_ui::observe(cx, |notify| files.subscribe(move || notify()));
  ```
  Keep the returned `Subscription` in the view.
- Each view crate exposes `pub fn init(cx: &mut App)` for its actions and key
  bindings. The app calls every `init`.
- Take styling from `notefig_ui` theme tokens, which port `styles.css`, and
  use gpui-kit components (buttons, inputs, lists, popovers, lucide icons).
  Match the TS app's look: compare against reference screenshots (below).

### Contracts between view crates

These are the seams the shell (`views/workspace`) composes. Keep the
signatures stable once published.

| provider | API |
|---|---|
| `views/file-tree` | `FileTreePanel::new(ws: WorkspaceHandle, window, cx) -> Self`, an `Entity` that renders and is `Focusable` |
| `views/search` | `SearchPanel::new(ws, window, cx)` |
| `views/git` | `GitPanel::new(ws, window, cx)` |
| `views/agent` | `SessionsPanel::new(ws, window, cx)`; `ChatTab::new(ws, task_id: String, window, cx)`; `prompt_widget_view(...)` for the editor's node views; `HarnessSettings` section |
| `views/usage` | `UsageSettings` section |
| `views/settings` | `open_settings(section: Option<&str>, window, cx)`, which composes the agent and usage sections |
| `views/command-palette` | `toggle(window, cx)` |
| `views/welcome` | `Welcome::new(window, cx)` |
| `views/workspace` | the window body: workspace rail, sidebar (view tabs Files / Search / Git / Sessions), panes with tab strips and splits, editor host with toolbar and status bar |

A tab's content is chosen by the tabs module's tab kind (TS `modules/tabs`):
document → editor host, agent chat → `ChatTab`, and so on.

### Modules other modules lean on (land these APIs early)

- `documents` and `editors` (shell): open documents, their text, dirty and
  saving state, and adopting an external or agent write into a live editor as
  one undoable change. Agents write through this API, as `agent-service` does
  in TS.
- `tabs` and `layout` (shell): open a tab of a kind and focus it. Agents open
  chat tabs; files opens documents.
- `files` (files): a workspace's file list and tree, reading and writing,
  `"files:changed"`.

## Seeing what you build

**Script driver plus screenshots.** Build with `--features screenshot`, then:

```bash
NOTEFIG_HEADLESS=1 NOTEFIG_STATE_DIR=$SCRATCH/state NOTEFIG_AGENT_MOCK=1 \
NOTEFIG_SCRIPT='wait:800; shot:/abs/out.png; key:cmd-p; type:readme; wait:300; shot:/abs/out2.png; quit' \
  target/debug/notefig /abs/workspace
```

The steps are `wait`, `key`, `type`, `action`, `click`, `dblclick`, `rclick`,
`move`, `scroll`, `resize`, `shot` and `quit` (`crates/ui/src/driver.rs`).
GPUI renders the frame into a texture, so this needs no Screen Recording
permission. Read the PNG to check it. Coordinates are logical pixels, half a
2x screenshot's. A view crate can carry an `examples/<name>.rs` that opens a
window with just its view over a core (call `notefig_ui::driver::run_from_env`).
That lets you check a view before the app hosts it.

**Reference screenshots of the TS app:** see `tools/ref-shots/README.md`. Write
`tools/ref-shots/<surface>.spec.ts` for the states you need. The TS web build
runs with mock agents on port 1420.

**Always run headless (`NOTEFIG_HEADLESS=1`: the window is never shown or focused) with `NOTEFIG_STATE_DIR` set to a scratch folder** when running the
app, so the user's own app state is never touched.

## Build rules (disk is tight: about 6 GB free)

- One shared target dir: `gpui-spike/target`. Never set `CARGO_TARGET_DIR`,
  never `cargo clean`, never build `--release`.
- `cargo check -p <crate>` or `cargo test -p <crate>`. Several agents build at
  once and cargo's lock serialises them; waiting on the lock is expected.
- Don't add heavy dependencies without need: no tokio-full, no reqwest stacks.
- Run `df -h /` now and then. Below 2 GB free, stop building and report.
- Don't commit. Don't touch anything outside `gpui-spike/`.

## Ownership

Edit only the crates you own. To change a crate you don't own, don't: work
around it and report what you needed. Add your crates' dependencies in your
own `Cargo.toml` files only. `crates/core`, `crates/platform` and the root
`Cargo.toml` belong to the lead, so report any changes you need to them.
`crates/ui` belongs to the shell owner, but others may **add new files** to
it and one `pub mod` line to its `lib.rs`. `crates/app/src/app_core.rs`
belongs to the shell owner. Other owners add their module markers to its
lists and their view `init`s to `main.rs`, as one-line additions, and only
when their crate is green.
