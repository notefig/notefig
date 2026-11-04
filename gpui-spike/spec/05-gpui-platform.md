# 05 — Target platform: GPUI and its ecosystem (state as of 2026-10-31)

Spike question: what can GPUI and the crates around it do *today* for a native
Rust port of Notefig (WYSIWYG markdown editor + ACP agent driver + git client),
Mac first, keeping Windows, Linux and web (wasm) possible.

Everything below was checked against crates.io, the GitHub API and local builds
on this Mac (rustc 1.99.1, `rustup update stable` was required — see §1.4).

---

## 1. GPUI itself

### 1.1 Three ways to depend on it

| Source | Crate name | Version (2026-10-31) | Notes |
|---|---|---|---|
| crates.io, official | `gpui` | **0.2.2**, published 2025-10-22 | A year stale. Upstream `crates/gpui/Cargo.toml` still says `0.2.2`; Zed has not republished. The platform split (`gpui_platform`, `gpui_macos`, `gpui_web` …) that happened since is **not** on crates.io under these names. Don't use. |
| git, official | `gpui` + `gpui_platform` from `zed-industries/zed` | main @ `ba63a022` (2026-10-31) | Always current, but drags Zed's whole workspace (`workspace = true` deps), needs Zed's pinned toolchain (`rust-toolchain.toml` → **1.98.1**), and breaks weekly. Pin a `rev`. |
| crates.io, snapshot | `gpui-pre` (+ `gpui-pre-platform`, `gpui-pre-web`, `gpui-pre-macros`, `gpui-pre-sum-tree`, …) | **0.3.10** (2026-10-26, snapshot of `zed@08cbb88`) | Published weekly by Jason Lee (huacnlee, Longbridge) since 2026-09-03. This is what gpui-kit pins (`=0.3.10` in 0.8.1, `=0.3.9` in 0.8.0). Used via `gpui = { package = "gpui-pre", version = "=0.3.10" }` so code still says `use gpui::*`. |
| crates.io, fork | `gpui-fast` (+`-platform`, `-web`) | 0.1.12 (2026-10-26) | Longbridge's fork "with rendering and layout optimizations"; opt-in via `gpui-kit/gpui-fast`. Not needed for the MVP. |

Upstream's README now says: depend on `gpui` and `gpui_platform`, start with
`gpui_platform::application().run(...)`; `gpui_platform` picks the backend by
`cfg(target_os)` — `gpui_macos` (Metal; `font-kit` feature needed for glyphs),
`gpui_windows` (DirectX/DirectWrite), `gpui_linux` (`wayland`/`x11`, wgpu
renderer via `gpui_wgpu`), `gpui_ios`, and `gpui_web` on wasm.

**Pin rule:** every `gpui-pre-*` crate must be the same exact version, and
everything in the graph that touches GPUI types (gpui-kit, the markdown editor)
must agree on it — two snapshot versions in one graph means two incompatible
`gpui::Entity` types. Bump together.

### 1.2 Platform support

| Platform | Status |
|---|---|
| macOS | First-class (Zed's home platform). Metal renderer, CoreText via `font-kit`. Built and ran here. |
| Windows | Shipping (Zed for Windows GA since late 2025). Win32 + DirectWrite + DirectX 11. |
| Linux | Shipping. Wayland + X11, wgpu (Vulkan) renderer since the `gpui_wgpu` split. |
| Web / wasm | **Official, in-tree:** `crates/gpui_web` in zed main (snapshot on crates.io as `gpui-pre-web`). See §5. |
| iOS | `gpui_ios` exists in-tree; out of scope. |

### 1.3 Text system (what the editor port leans on)

Verified in `gpui-pre 0.3.9` source:

- **Shaping:** `TextSystem::shape_line(text, font_size, &[TextRun], ..)` and
  `shape_text` (wrapped, multi-line). Platform shapers: CoreText (mac),
  DirectWrite (win), cosmic-text/swash (linux, and the web backend has its own
  `canvas_text.rs` + glyph cache). Font fallback is platform-provided.
- **Rich text runs:** `TextRun { len, font, color, background_color, underline,
  strikethrough }` — styled byte ranges over one string. `StyledText::new(s)
  .with_runs(..)` / `.with_highlights(..)`, and `InteractiveText` for
  click/hover on ranges. This is enough for inline marks (bold/italic/code/link)
  but not for inline *objects* (images, chips, mention tokens) — those need a
  custom `Element` that lays out mixed text and boxes. gpui-kit already did
  this (`base::text::inline_flow`, `inline_object`).
- **Hit-testing:** `ShapedLine::{index_for_x, closest_index_for_x, x_for_index}`,
  `WrappedLine::{index_for_position, position_for_index}`, and
  `TextLayout::{index_for_position, position_for_index}` on `StyledText`.
  Byte offsets, UTF-8.
- **IME:** `EntityInputHandler` (`text_for_range`, `selected_text_range`,
  `marked_text_range`, `unmark_text`, `replace_text_in_range`,
  `replace_and_mark_text_in_range`, `bounds_for_range`,
  `character_index_for_point`, `paste`) wrapped by `ElementInputHandler` and
  registered in paint with `window.handle_input(..)`. Offsets are **UTF-16**
  (NSTextInputClient convention) — the editor must map UTF-16↔UTF-8. The web
  backend implements IME via a hidden textarea mirror (`gpui_web/src/ime_mirror.rs`).
- **Accessibility:** AccessKit is now a direct dependency of `gpui`
  (`crates/gpui/src/_accessibility.rs` guide, `examples/a11y`). Elements with
  ids can expose roles/names/actions. gpui-kit claims AccessKit roles on its
  components and tests them. Rich-text editors are the weak spot: the wabzqem
  editor exposes the document as one multi-line text input plus a node per
  top-level block; VoiceOver behaviour is unverified everywhere.

### 1.4 Toolchain

`gpui-pre 0.3.9+` uses `<[T]>::as_array` (stabilised after 1.91), so the
installed **1.91.1 fails** (`E0658 slice_as_array` in `gpui-pre-util`). I ran
`rustup update stable` → **rustc 1.99.1**, after which everything built. Zed
main pins 1.98.1. gpui-kit's web gallery uses **nightly** (wasm threads); the
desktop build is stable. Pin `rust-toolchain.toml` to `1.99` (or ≥1.98).

---

## 2. UI kits: "gpui-kit.com" vs "longbridge gpui-component"

**They are the same project.** `github.com/longbridge/gpui-component` now
redirects to `longbridge/gpui-kit` (18.8k stars, pushed 2026-10-29). It was
restructured into layers, all Apache-2.0, versioned together (0.8.1,
2026-10-26; weekly releases):

| Crate | Role |
|---|---|
| `gpui-kit` | Facade, the one dependency apps use. Re-exports `gpui`, `gpui_kit::base`, `gpui_kit::component`, assets; provides `gpui_kit::application()`, `init`, `open_window`. Pins `gpui-pre =0.3.x`. |
| `gpui-base` | Unstyled behaviour/state: input engine, text (markdown/HTML parse + render, `editor_host` seam), dock layout, virtual list, focus trap, undo history, a11y. |
| `gpui-component` | Styled ("shadcn-like") components + theme. |
| `gpui-kit-assets` | Lucide icons. |
| `gpui-shell`, `gpui-webview`, `gpui-fps` | JS extension host, embedded webview, FPS overlay. |

Components (from `crates/component/src`): accordion, alert, attachment,
avatar, badge, breadcrumb, bubble, button, carousel, chart/plot, checkbox,
clipboard, collapsible, color picker, combobox, **command palette**,
description list, dialog, **diff**, **dock** (panels/tabs/splits), form,
group box, **highlighter** (tree-sitter or syntect), hover card, **input**
(single line, textarea, **code editor** on a rope with tree-sitter + LSP
hooks, "stable at 200K lines"), kbd, label, link, **list / virtual list /
searchable list**, menu/context menu/**native menu**, message/message
scroller (chat bubbles), notification/toast, pagination, popover, progress,
radio, rating, resizable, scroll, select, setting pages, sheet, shimmer,
**sidebar**, skeleton, slider, speech (mic + system recognizer), spinner,
status bar, stepper, switch, tab, **table/data table**, tag, **text**
(`TextView`: markdown + HTML rendering, selectable), theme, time/date picker,
title bar, toolbar, tooltip, **tree**, window border.

Markdown in gpui-kit: `TextView` renders (read-only, selectable, streaming
with fade-in) markdown/HTML parsed with the `markdown` (markdown-rs) crate
into `BlockNode`s. There is **no WYSIWYG editor in gpui-kit itself**; the
in-tree block-editor PRs (#3049, #3566) were moved out into the wabzqem crate,
and gpui-kit instead exposes the public `gpui_kit::base::text::editor_host`
seam the editor renders through.

Maturity: heavy churn (0.6 → 0.8 in six weeks, a yanked release), but used in
production by Longbridge Pro and by many apps; best-in-class for GPUI. No
competitor comes close (gpui-luma, gpui-toolkit/pierreaubert are small).

**Recommendation:** use `gpui-kit` as the only UI kit. There is nothing to
"coexist" with — `gpui-component` is a layer inside it; depend on the facade,
not the layers directly (their README asks for this too).

---

## 3. wabzqem/gpui-kit-markdown-editor

Cloned to `scratchpad/research/gpui-kit-markdown-editor` (commit `bc8befe`).

| | |
|---|---|
| What | **True block-based WYSIWYG** markdown editor (not source+preview). Renders headings, lists, tasks, quotes, code, tables inline and editable; the markdown source is a serialization. |
| Author / activity | Richard Nelson (@wabzqem), single author, 51 commits. Repo created 2026-10-17, v0.1.0 2026-10-21, v0.1.1 2026-10-27, 11 stars, 0 issues. Extracted from gpui-kit PRs #3049/#3566 with history; designed with review from gpui-kit's maintainer (huacnlee). |
| License | Apache-2.0. |
| Size | ~12.5k lines of library Rust + 6.6k lines of tests (235+ test fns: round-trip, commands, property tests, view tests) + 784-line design doc with decisions D1–D22. |
| Deps | `gpui = { package = "gpui-pre", version = "=0.3.9" }`, `gpui-kit = "0.8.0"`, `markdown = "1.0.0"` (markdown-rs, via gpui-kit's parser), `unicode-segmentation`. Features `syntect` (default) / `tree-sitter` for code blocks. |
| Build | `cargo build --example story` **succeeds** on rustc 1.99.1 (fails on 1.91.1). The story ran (≈130 MB RSS, stable). Screenshot could not be taken: `screencapture` returns "could not create image from display" (no Screen Recording permission for this terminal), so the description below uses the repo's `docs/screenshot.png`. |

**What it looks like** (repo screenshot of the story): a toolbar row of plain
buttons (B, I, S, `code`, Text, H1–H3, Bullets, Numbered, Task, Link, Code,
Table, ±Row, ±Col, Sample, "Load 1200 blocks", revision counter); below it the
editor: an H1 "Block editor", a paragraph with live bold/italic/inline-code/
strike marks, an H2 "Lists" with bullet, nested bullet and numbered items,
a rust code block in a grey card with a language label; under that a live
"Markdown" pane showing the serialized source. Clean, Notion/Typora-like
rendering with gpui-kit's default theme.

**Architecture** — deliberately ProseMirror-shaped:

- `EditorDocument`: block tree with process-unique never-reused `BlockId`s,
  parent links, an order index. Containers (root, quote, list, item, table,
  row, cell) and leaves: `Inline(InlineText)` (text + normalized mark runs),
  `Plain(String)` (code), `Atom` (image, hr, footnote def, unknown/HTML, kept
  verbatim).
- Positions: `BlockPosition { block, offset }` (UTF-8 byte offset on a
  grapheme boundary), validated; selections are text ranges, whole blocks, or
  table-cell rectangles.
- **One edit path:** invertible `Step`s grouped into transactions; undo/redo
  with intent-based coalescing; `EditorCommand` API (ToggleMark, SetBlockKind,
  ToggleList/Task, Indent/Outdent, MoveBlocks, InsertBlock, …) = toolbar API.
- Import: markdown-rs AST → gpui-kit `BlockNode` → model. Export: own
  canonical serializer (round-trips through the same parser; *not*
  byte-preserving: `*` vs `_`, list tightness can change once; empty
  paragraphs vanish).
- Render: model → gpui-kit `BlockNode` projection (dirty blocks only) →
  gpui-kit's text renderer via `editor_host`; off-screen top-level blocks are
  culled. Paint never mutates the model.
- Input: own `EntityInputHandler` (IME, UTF-16 mapping), input rules
  (`# `, `- `, `1. `, `[ ] `, `> `, ```` ``` ````, `**x**`, …), clipboard as
  markdown, host-controlled paste/links (`PasteRequested`, `LinkClicked`,
  `EditLinkRequested`), `SubmitPolicy` for chat-composer use, "captured range"
  API for dictation/agent inserts.

**Gaps vs Notefig's TipTap editor:** no collaborative/CRDT story; no
`source_offset` mapping (needed to map agent edits / git diffs to positions);
no pluggable node types beyond opaque atoms (Notefig's custom nodes — wiki
links, embeds, agent chips, frontmatter UI — would need extension work);
nested lists/long tables not culled; macOS/Windows key bindings + IME
"implemented but unverified" (developed on Linux/Xvfb); a11y minimal;
drag-reorder only for tables/code blocks; no slash menu / floating toolbar
(left to host, and the API supports it). Tied to `gpui-kit`'s
`editor_host` API, so it moves in lockstep with gpui-kit releases (0.8.0 →
0.8.1 already split the graph, see §7).

**Verdict:** a viable base — it already *is* the "ProseMirror-like model"
we would otherwise write (stable ids, steps/transactions, mapping-ready
positions, commands, input rules), with serious tests and a written design.
Writing our own would cost months to reach the same point. Code quality is
high (docs, decision log, no `unsafe`, property tests). Risks are bus factor
(one author, two weeks old) and gpui-kit lockstep. **Fork it** (vendor as a
workspace crate, track upstream, upstream fixes) rather than depend on it
blind, and plan for Notefig-specific node types in the fork.

---

## 4. Prior art worth reading

| Thing | Where | Use for |
|---|---|---|
| Zed `markdown` crate | `crates/markdown` (pulldown-cmark → selectable rendered markdown, code highlighting via language registry) | Read-only rendering of agent messages; selection over rendered text. gpui-kit `TextView` is the closer-to-hand equivalent. |
| Zed `markdown_preview` | `crates/markdown_preview` | Source + preview pattern (the thing we are *not* doing). |
| Zed `editor` + `multi_buffer` + `text` + `rope` + `sum_tree` | `crates/editor`, `crates/multi_buffer`, … | Code editor (display map, folds, inlays, multibuffer excerpts). Reference for diff views and the git panel's diff; *not* a WYSIWYG model. `sum_tree` is published (`gpui-pre-sum-tree`). |
| Zed ACP | `crates/acp_thread`, `crates/agent_servers`, `crates/agent_ui`, `crates/acp_tools` on `agent-client-protocol` (crates.io **3.6.0**, 2026-10-28) | Direct reference for spawning ACP agents, the thread model (messages, tool calls, diffs, permission prompts) and the agent panel UI in GPUI. |
| Zed git panel | `crates/git`, `crates/git_ui`, `crates/git_ui_core` | Status list, staging, commit composer, diff hunks in GPUI. Zed shells out to `git` CLI + uses `git2` in places. |
| `prosemirror` crate | fiduswriter/prosemirror-rs, 0.5.2, MIT | ProseMirror *model + transform* in Rust (schema from JSON SpecSchema, steps, mapping). No view. Could replace the wabzqem model if we needed ProseMirror-JSON compat (e.g. migrating TipTap docs/collab); otherwise the wabzqem model is better integrated. |
| `parley` (0.12) / `cosmic-text` (0.19) | Linebender / Pop!_OS | Standalone rich-text layout. Not needed: GPUI's own text system + gpui-kit's inline flow cover it; mixing a second shaper in GPUI would be fighting the framework. |
| `yrs` 0.28 / `loro` 1.17 | CRDTs | Only if collaboration returns; neither is wired to any GPUI editor today. |
| `gix` 0.90 / `git2` 0.21 | git | `gix` is pure Rust (better for wasm someday); `git2` is libgit2. Desktop can also shell out to `git`. |

---

## 5. Wasm reality check

**GPUI on the web is real and upstream.** `crates/gpui_web` in zed main:
one document-owned `<canvas>`, **one top-level window** (a second
`open_window` returns `WebWindowError`), WebGPU with automatic WebGL2
fallback via `gpui_wgpu`, its own canvas-based text system + glyph cache +
font fallback, keyboard/composition events, IME via a hidden textarea mirror,
clipboard via `navigator.clipboard`, http client via fetch, executor via
`requestAnimationFrame`/idle callbacks. `executor.block()` cannot block on
wasm. Threads (`multithreaded`, default) need **nightly** and a
cross-origin-isolated page (COOP/COEP headers); turning the feature off builds
on stable, single-threaded. gpui-kit ships a wasm component gallery
(`crates/story-web`, wasm-bindgen + Vite, live at gpui-kit.com/gallery), so
gpui-kit components compile to wasm32 too.

| Piece | wasm32-unknown-unknown |
|---|---|
| gpui (`gpui-pre` + `gpui-pre-web`) | Yes (official). |
| gpui-kit | Yes (story-web). Speech/webview/native-menu features obviously not. |
| wabzqem editor | Probably (pure model + gpui-kit render; no fs/process). Untested. |
| markdown-rs, pulldown-cmark, syntect (fancy-regex build), tree-sitter (needs wasm C toolchain / tree-sitter's wasm build — painful) | Mostly yes; prefer syntect on web. |
| `agent-client-protocol` types | Yes (serde types). **Running agents: no** — ACP agents are local processes over stdio; the web build must reach them over a WebSocket/HTTP bridge to a host (Notefig CLI / a remote). |
| tokio process / fs / `std::thread` | No. |
| git: `git2` | No (libgit2 C + fs). |
| git: `gix` | Parts of it (objects, config, diff) compile; anything with lock files/tempfiles/fs does not. Practically: web needs a server-side git or an in-browser git over a virtual fs (isomorphic-git via JS interop). |
| storage | No `std::fs`: use IndexedDB/OPFS via `web-sys` behind the same trait the desktop fs adapter implements (mirrors today's IndexedDB/File System Access adapters in the TS app). |

So a web build looks like today's browser mode: same UI crate compiled to
wasm, a `Platform` trait whose web impl uses OPFS/IndexedDB + fetch/WebSocket
to a backend for git and agents, single window (workspaces as tabs, not
windows). Design the core so fs, git and agent transport are traits from day
one; keep `tokio::process`/`git2` in a desktop-only crate.

---

## 6. Hands-on log

- `rustc 1.91.1`: `gpui-pre-util 0.3.9` → `error[E0658]: use of unstable library feature slice_as_array`.
- `rustup update stable` → 1.99.1. `cargo build --example story` in the editor: OK
  (one future-incompat warning from `block v0.1.6`, an objc dependency). Clean build ≈ a few minutes; 884 crates in its lockfile.
- Story binary launched and stayed up; screenshot blocked by macOS Screen
  Recording permission (both sandboxed and unsandboxed `screencapture`).
- MVP crate (`scratchpad/mvp`) with the deps in §7: see build result there.

---

## 7. Recommendation

**GPUI source:** the `gpui-pre` snapshots on crates.io, *through gpui-kit's
pin*, not the stale `gpui 0.2.2` and not a raw zed git dep. That gives a
reproducible lockfile, crates.io-only builds, the official web backend
(`gpui-pre-web`) on the same snapshot, and weekly upgrades in lockstep with
the UI kit. Keep the option to switch to a zed git rev later (code is
identical: `use gpui::*`).

**UI kit:** `gpui-kit` (facade). It *is* longbridge's gpui-component.

**Editor:** fork `wabzqem/gpui-kit-markdown-editor` into the workspace
(`crates/markdown-editor`), keep Apache-2.0 notices, track upstream. Don't
build a ProseMirror clone from scratch; extend the fork with Notefig node
types, `source_offset` mapping and macOS IME verification.

**Version lockstep caveat (verified):** the editor 0.1.1 pins
`gpui-pre =0.3.9` + `gpui-kit 0.8.0`; gpui-kit 0.8.1 pins `gpui-pre =0.3.10`.
Mixing them gives two GPUI copies. Until the fork bumps itself, the MVP uses
gpui-kit **=0.8.0** and gpui-pre **=0.3.9**; when we vendor the fork, bump
all three to 0.8.1 / 0.3.10 together.

```toml
# rust-toolchain.toml
[toolchain]
channel = "1.99.1"

# Cargo.toml (app crate)
[dependencies]
gpui = { package = "gpui-pre", version = "=0.3.9" }
gpui-kit = { version = "=0.8.0", features = ["syntect"] }
gpui-kit-markdown-editor = { git = "https://github.com/wabzqem/gpui-kit-markdown-editor", rev = "bc8befe" }
agent-client-protocol = "3.6"
```

(After vendoring: `gpui-kit-markdown-editor = { path = "crates/markdown-editor" }`
with the fork's own deps bumped to `gpui-pre =0.3.10` / `gpui-kit =0.8.1`.)

Web later: add `gpui_web = { package = "gpui-pre-web", version = "=0.3.9", default-features = false }`
under `[target.'cfg(target_family = "wasm")'.dependencies]` (stable,
single-threaded) — gpui-kit already wires its own web platform via
`gpui_kit::application()`.
