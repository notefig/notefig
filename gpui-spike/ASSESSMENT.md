# Notefig on Rust + GPUI: assessment (round 2, the modular port)

Branch `parsa-gpui-spike`, worktree `~/Documents/notefig-gpui`, everything in
`gpui-spike/`. Nothing is committed.

## What changed since the first spike

The first spike was an editor plus a monolithic shell, and it couldn't answer
whether a port is a sensible move. This round ports the TS app's
**architecture** one to one, and nearly all of its surface:

- **`crates/core`** is a port of `@notefig/core`: modules, `needs` ordering,
  services, typed hooks, and the workspace lifecycle (`open`, `focus`,
  `close`, rollback, supersede). The TS kernel tests are ported.
- **One crate per TS module (36 crates, `crates/modules/*`), none depending
  on GPUI.** Each has a public API, private internals, and its TS tests
  ported. The TS source was the spec. Where they diverge, the crate's docs say
  so.
- **Views (13 crates, `crates/views/*`)**, playing the role of `components/`.
  `crates/app/src/app_core.rs` mirrors `app-core.ts`.
- **`crates/platform`** is the platform service (`IPlatformAdapter`), with a
  fake for tests. `crates/platform-native` implements it on the desktop.
- The rules every crate follows are in `ARCHITECTURE.md`.

## Try it

```bash
cd ~/Documents/notefig-gpui/gpui-spike
cargo run -p notefig-desktop -- ~/some/notes            # binary `notefig`
NOTEFIG_AGENT_MOCK=1 cargo run -p notefig-desktop -- …  # scripted mock agents
```

- On first launch it imports the Tauri app's data, read-only. It skips the
  import when `NOTEFIG_STATE_DIR` is set, or when `NOTEFIG_TAURI_DATA_DIR=none`.
- **Headless and scripted:**
  ```
  NOTEFIG_HEADLESS=1 NOTEFIG_STATE_DIR=<scratch> NOTEFIG_TAURI_DATA_DIR=none NOTEFIG_SCRIPT='wait:800; click:x,y; shot:/abs.png; quit'
  ```
  GPUI renders the frame to a PNG, so no window and no Screen Recording
  permission are needed. The steps are listed in `crates/ui/src/driver.rs`.
- **TS reference screenshots:** `tools/ref-shots/` (Playwright against the TS
  web build). GPUI screenshots are in `tools/ref-shots/gpui/`.

## Where it stands

| | |
|---|---|
| Tests | **1,097 pass, 0 fail**, 7 ignored (`cargo test --workspace`) |
| Rust lines (non-test) | modules 29.0k, views 24.9k, editor 18.8k, agent protocol 5.6k, core + platform + ui 5.6k, history 1.4k, app 0.5k |
| TS it replaces | modules 20.0k, components 19.3k (plus `@notefig/core`, adapters, `packages/{agent,dictation,shared/tunnel}`) |
| Disk | one feature set for gpui and gpui-kit; a clean target is about 3 GB |

**Checked in the real app** (headless, screenshots against TS):

- **Shell:** layout and look nearly pixel for pixel with TS.
  - Floating sidebar, workspace rail, the Files/Search/Git/Sessions tool tabs, the toolbar and the status bar.
  - Dock with drag-to-split, reorder and edge docking. Everything view, a collapsed sidebar, right-to-left layout, light and dark themes.
  - Editor typography within a few pixels of TS's prose styles.
- **Files:**
  - Tree with inline create and rename, context menu, delete with confirmation, and drag and drop (checked on disk).
  - Live external changes, scratchpad landing, restoring several workspaces, the welcome screen with recents and harness readiness.
- **Agents:**
  - Sessions panel, trust gate, chat (thoughts, plan, tool calls, diff cards with syntax colours and split view), permission and auth cards.
  - Composer with directives, the context meter, and model and effort pickers.
  - The `/` widget: its full state machine, choices, summoning on a selection with a reference, the deletion veto while running, the minimap, and jumping to a widget.
  - Needs-attention state (`notefig-attention`).
- **Live, with real Claude Code** (about $0.60 over both rounds):
  - A chat write adopted into the open editor, and reverted with ⌘Z in the editor and on disk.
  - A `/` widget round answered over `widget_respond` through the relay.
  - A session revived after a restart, with its transcript replayed.
- **Git:** the checkpoint panel from end to end, including a checkpoint after a mock turn and restore through the open document (undoable).
- **Settings:**
  - All six sections, including Usage with every chart and Harnesses.
  - Search with jump to the match, and the command palette with all 16 TS commands and quick open.
  - The debug panel, the feedback form (never sends), and telemetry consent (sends nothing).
- **Extras:**
  - The tunnel ("Connect a machine"): passes the TS test vectors and paired with the real `notefig agent` worker.
  - **Dictation** on the bundled Parakeet model via onnxruntime: it transcribes the TS e2e clip exactly.
  - Menu-bar status with attention.
  - Updater UI (its backend always answers "up to date").
  - Read-only import from the Tauri `notefig.db`: 17 collections and 114 tasks from a copy.

## What isn't at parity (most important first)

1. **Editor renderer details.** Most are fixed without forking gpui-kit. The
   editor now draws list markers itself (`crates/markdown-editor/src/list.rs`):
   bullets, numbers, checkboxes, right-to-left markers, code-block size and quote
   continuation lines all measure the same as TS
   (`tools/ref-shots/{out,gpui}/editor-gaps-*`). What remains:
   - Bold is grey, not white. gpui-kit's `mark_highlight` hard-codes it; it needs
     a `TextViewStyle::with_strong` hook (upstream or a small fork).
   - TS's inline opening quote mark pushes a quote's first line about 8px in.
     GPUI text has no first-line indent.
   - Only list items take their own direction from their text. In TS every
     paragraph, heading, quote and code block does (`dir="auto"`). In GPUI the
     workspace direction still aligns them: an English paragraph in a
     right-to-left workspace is right-aligned.
2. **Platform text services WebKit gives for free:** spellcheck, autocorrect,
   Writing Tools, Look Up, and screen-reader access to rich text. These are
   unchanged from round 1 and remain the biggest real cost of the move. IME has
   not been tested by hand.
3. **Not exercised by hand:**
   - holding right ⌥/Ctrl for dictation (the mic needs permission, and the driver can't hold a key)
   - the menu-bar item on screen
   - dragging in from Finder
   - Windows and Linux (nothing ran there)
4. **Small gaps:** the shake on a refused delete, focusing the composer after a
   minimap jump, the live draft as a minimap dot's title, and the debug panel's
   URL, tab and git rows are now ported. Left:
   - the shake ignores reduced motion (GPUI doesn't expose the setting)
   - the debug sheet scrolls its toolbar and URL row with the body
   - the real update channel and feedback transport, absent by design
5. **Deliberate deviations:**
   - The agent runtime runs on its own thread, with harnesses and probing inside it rather than as separate modules.
   - `git-worker` gets no crate, because gix runs off the main thread through core's executor.
   - TS's `ProcessSurface` isn't ported: agents use `notefig-agent`'s process host, and the tunnel's transport provides the seam for the web.

## Is it a logical move?

**The architectural question is answered: yes, a 1:1 port is viable.**

- **The TS module system translates almost mechanically.** `defineModule`
  becomes a trait, `CoreModules` and hook-map merging become types, and
  factories plus fakes become the same pattern in Rust. Six agents ported 36
  modules in parallel against one contract, with crate boundaries enforcing
  what Fallow enforces in TS. Integration was mostly one-line additions to
  `app_core.rs`.
- **Keeping modules free of GPUI paid off:** every module is tested over the
  fake platform, with no UI. The same crates could back the CLI or a wasm
  build. They still need web platform backends.
- **Fidelity is reachable.** The window matches the TS screenshots nearly
  pixel for pixel. The remaining differences are in gpui-kit's text renderer,
  which we would fork.
- **Performance is better.** Typing on the 8k-line SLO document is 5.9 ms p50
  in a *debug* build, against a 50 ms p95 in today's app.

**What it costs:**

- **The renderer.** Owning the editor fork plus a gpui-kit text-renderer
  fork, with GPUI pre-1.0, means weekly `gpui-pre` snapshots pinned in
  lockstep.
- **Platform text services and accessibility.** WebKit provides these for
  free; GPUI doesn't.
- **The web build.** It would stay on React until GPUI's web backend is
  proven. The UI stack type-checks for wasm on nightly, but nothing has run
  there.

**Revised estimate:** with the architecture and most of the surface ported,
the remaining desktop work is mostly:

- polish against the TS screenshots
- the renderer fork
- text services and accessibility
- packaging, signing and updater backends
- Windows and Linux bring-up

That is roughly **2–3 months for 2 engineers** to a shippable desktop build, down
from 4–6 months. The web stays a separate, later track.

**Before deciding:**
1. Use the app for an hour. Build it with `cargo run -p notefig-desktop`;
   a headless run doesn't show the feel.
2. Do a hand pass on Japanese and Chinese IME, VoiceOver, and dictation.
3. Build and run once on Windows.
4. Decide whether forking gpui-kit's text renderer is acceptable.

## Where to read more

- `ARCHITECTURE.md`: the contract (kernel, platform, views, ownership, the
  screenshot workflow).
- Each crate's `lib.rs` documents its API and its divergences from TS.
- `spec/01–05`: the specs from round 1.
