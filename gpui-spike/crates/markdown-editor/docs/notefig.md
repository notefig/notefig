# Notefig additions to the editor

This fork (`crates/markdown-editor`, library `markdown_editor`) now carries
the Notefig editor features from `spec/01-editor.md`. The audit of the base
is in [notefig-audit.md](notefig-audit.md). All of this is covered by
`cargo test -p gpui-kit-markdown-editor` (296 lib tests + 6 story tests,
of which 58 are new; plus 3 ignored perf harnesses in `src/tests/perf.rs`: `src/tests/notefig.rs`, `src/tests/notefig_view.rs`).
`cargo run -p gpui-kit-markdown-editor --example story` opens a demo loaded
with the Notefig fixtures.

## 1. Markdown fidelity: source-preserving save

`source()` / `source_snapshot()` no longer re-serialize the whole document.

- At import every top-level block records its exact source bytes and the
  bytes between it and the previous block (`source_map.rs`).
- On save, a block whose content revision is unchanged writes its original
  bytes; two untouched blocks that were adjacent keep their original
  separator; the bytes after the last block (trailing newlines) are kept.
- Only edited or new blocks go through the canonical serializer, separated
  by a blank line. A file that ended with one newline still does.
- An edited block whose canonical form equals its original's (e.g. after
  undo) writes its original bytes again.
- Blocks that normalization merges at import (`* a` then `+ b`, which the
  model holds as one list) keep the combined source.
- HTML comments, raw HTML blocks, footnotes and unknown constructs were
  already opaque source atoms in the fork; they now also round-trip byte for
  byte when edited around.
- Canonical serializer changes: a hard break is written `\` + newline
  (TipTap's form) where safe, `<br>` otherwise (tables, marked text, end of
  block); an empty task item writes `- [ ]` with no trailing space;
  `- [ ]`/`- [x]` with no text import as empty task items.

Verified: every fixture in `tests/fixtures/notefig/` (meeting notes with
frontmatter, widgets and diff fences, CRLF, the desktop agent-fixture
README, a messy file with odd spacing/markers, no final newline, a
scratchpad) and the upstream `tests/fixtures/test.md` open and save
unchanged; 20 inputs from `markdown-roundtrip.test.ts` (non-canonical forms)
are identities; editing one heading changes exactly that line; undo restores
the original bytes; an 8k-line generated document round-trips (debug build:
parse ≈136 ms, save ≈1.4 ms, merge of a one-line change ≈134 ms).

## 2. Notefig syntax

| Construct | Model | On disk |
|---|---|---|
| YAML frontmatter | document-level atom (`Step::SetFrontmatter`, undoable) | raw bytes while untouched, else `---\n{yaml}\n---\n` + blank line; empty removes it. Split rule as `splitFrontmatter` (CRLF ok, unclosed fence is a rule) |
| `<!-- notefig:prompt id="…" task="…" -->` (also positional `<id> <task>`) | `Custom` block atom holding a [`PromptWidget`]; repeated ids dropped | marker while bound; **nothing** while unbound (`task: None`) |
| `<u>`, `<mark>` | marks (as before) | as before |
| `<sub>…</sub>`, `<sup>…</sup>` | inline atoms `notefig-sub`/`notefig-sup` (gpui-kit's `TextMark` has no sub/sup): shows the text, edited as one unit | `<sub>…</sub>` |
| `~~strike~~`, links, images, tables (+alignment), task lists, fenced code with language + syntect highlighting, `---`, hard breaks | as in the fork | preserved / canonical |
| ```` ```ts diff ```` | code block; `is_diff_fence(lang, meta)` | as written; rendered with green/red backgrounds on `+`/`-` lines |
| `@path` mention | inline atom `notefig-mention` (`insert_mention`) | `@path` (parse never creates chips, as in TipTap) |

Relative image paths resolve against `set_image_base_dir` (absolute paths
and URLs are used as is).

Shortcuts added (Cmd on macOS, Ctrl elsewhere): `M-u` underline,
`M-shift-s`/`M-shift-x` strike, `M-shift-h` highlight, `M-,` subscript,
`M-.` superscript, `M-alt-1..6` toggle heading, `M-shift-7/8/9`
ordered/bullet/task list, `M-shift-b` blockquote toggle, `M-alt-c` code
block toggle. Input rule `==x==` highlights. Pasting a URL over selected
text links it.

## 3. Prompt widgets (node views)

- `set_node_view_renderer(|ctx: &NodeViewCtx, window, cx| -> AnyElement)`:
  every top-level prompt-widget block is rendered by the app's element. It
  is measured like any block (culling and scrolling work), and its laid-out
  bounds are reported by `node_view_bounds()`.
- The element may host its own focusable entities (the draft input). The
  editor ignores mouse-downs inside node views, and all editor actions only
  act while the editor's own focus handle is focused (`guard` in
  `element.rs`), so keys typed in the widget's input never edit the
  document. The draft is not document content (not in the markdown).
- Caret: the widget is an atomic caret leaf (offset 0/1). Left/Right step
  onto and over it, Up/Down pass it. Backspace at the start of the block
  after a widget (Delete at the end of the block before) **selects** the
  widget; the next press deletes it; undo restores it.
  `NodeViewCtx::selected` tells the app when to show focus.
- `/` typed into an otherwise empty paragraph at top level or inside lists
  (not in quotes, tables, code) emits `BlockEditorEvent::SlashTrigger`
  (`set_slash_trigger(false)` disables it). The app answers with
  `insert_prompt_widget(widget, WidgetPlacement::Replace(block), cx)`; a
  landing paragraph is added after the widget. `set_prompt_widget` rebinds
  (marker follows), `remove_prompt_widget(block, Some("/"))` reverts.

## 4. External content merge

`apply_external_source(source, origin, cx)` (`merge.rs`):

- Parses the new text, diffs top-level blocks (prefix/suffix + LCS),
  keeps ids of unchanged blocks, edits a changed paragraph/heading/code
  block **in place** (minimal text replace, so carets inside map), and
  removes/inserts anything else. Frontmatter changes are a step too.
- ONE transaction, ONE undo entry (Cmd-Z undoes an agent write), origin
  `EditOrigin::External` or `EditOrigin::Agent { round }`. Identical text
  changes nothing and adds no undo entry. `EditOrigin::is_external()` lets
  autosave skip these `Changed` events.
- After the merge the document writes **exactly** the new bytes (the
  recorded sources are replaced in the same transaction, so undo brings
  back the old bytes too).
- Prompt widgets the new text dropped stay where they were;
  `MergeSummary::reinserted_widgets` counts bound ones (the app should write
  `source()` back, as `restoreDroppedWidgets` did).

## 5. Agent API

- PM positions (`pm.rs`), following TipTap's schema arithmetic: containers
  +2, textblocks 2 + UTF-16 text, table cells 4 + text, prompt widget 4,
  other atoms 1, inline atoms and hard breaks 1, frontmatter 1 at 0.
  `pm_size`, `pm_from_position`, `position_from_pm`, `pm_selection`,
  `pm_text_between(from, to, block_sep, leaf_text)`,
  `document_read_range(from, to)` (clamps; `textBetween(…, "\n")`),
  `window_around_pos`, `outline`, `nearest_preceding_heading`.
- Edits: `insert_at(pos, text, origin)`, `replace_range(from, to, text,
  origin)` (multi-line text is parsed as Markdown blocks); the user's
  selection is kept, mapped through the edit.
- Change tracking (`tracking.rs`): `track_changes(round)`; every
  transaction tagged `EditOrigin::Agent { round: Some(round) }` (merges,
  `insert_at`, `replace_range`) records the spans it touched; all later
  transactions, undo and redo map them; `tracked_changes(round)`,
  `changed_blocks(round)`, `restore_tracked_changes`, `untrack_changes`.
  `set_change_gutter(Some((round, color)))` paints one bar per changed
  top-level block; `change_gutter_bars()` returns their bounds.

## 6. UX

Placeholder ("Type something, or press / for AI…", `set_placeholder`) in
an empty document and in the focused empty paragraph; search highlights
(`set_search`, `select_search_match`, `search_matches`); link hover, Cmd-K
edit request and Cmd-click events were already there.

## Public API added (signatures)

```rust
// lib.rs re-exports
pub use notefig::{PromptWidget, WidgetPlacement, PROMPT_NODE, MENTION_NODE, SUB_NODE, SUP_NODE,
                  is_diff_fence, new_prompt_widget_id, strip_prompt_markers};
pub use notefig_view::{NodeViewCtx, NodeViewRenderer};
pub use merge::MergeSummary;
pub use pm::{DocHeading, DocumentRange};
pub use tracking::{RoundId, TrackedChange};

pub struct PromptWidget { pub id: SharedString, pub task: Option<SharedString> }
impl PromptWidget { pub fn marker(&self) -> String; pub fn parse_marker(html: &str) -> Option<Self>; }
pub enum WidgetPlacement { Replace(BlockId), After(BlockId), Caret }
pub struct NodeViewCtx { pub block: BlockId, pub widget: PromptWidget, pub selected: bool,
                         pub editor_focused: bool, pub editor: WeakEntity<BlockEditorState> }
pub struct RoundId(pub u64);
pub struct TrackedChange { pub round: RoundId, pub block: BlockId, pub range: Range<usize> }
pub struct MergeSummary { pub changed: bool, pub kept: usize, pub edited: usize, pub removed: usize,
                          pub inserted: usize, pub reinserted_widgets: usize }
pub struct DocHeading { pub level: u8, pub text: String, pub pos: usize }
pub struct DocumentRange { pub content: String, pub from: usize, pub to: usize, pub doc_size: usize }

// EditOrigin gains: External, Agent { round: Option<RoundId> }; fn is_external(&self) -> bool
// BlockEditorEvent gains: SlashTrigger { block: BlockId, position: BlockPosition }

impl BlockEditorState {
    pub fn set_node_view_renderer(&mut self, r: impl Fn(&NodeViewCtx, &mut Window, &mut App) -> AnyElement + 'static, cx: &mut Context<Self>);
    pub fn node_view_bounds(&self) -> Vec<(BlockId, Bounds<Pixels>)>;
    pub fn set_slash_trigger(&mut self, on: bool);
    pub fn insert_prompt_widget(&mut self, w: PromptWidget, at: WidgetPlacement, cx) -> Result<BlockId, CommandError>;
    pub fn set_prompt_widget(&mut self, block: BlockId, w: PromptWidget, cx) -> Result<bool, CommandError>;
    pub fn remove_prompt_widget(&mut self, block: BlockId, text: Option<&str>, cx) -> Result<bool, CommandError>;
    pub fn focus_after_widget(&mut self, block: BlockId, window: &mut Window, cx);
    pub fn insert_mention(&mut self, path: &str, cx) -> Result<(), CommandError>;
    pub fn frontmatter(&self) -> Option<&str>;
    pub fn set_frontmatter(&mut self, yaml: Option<&str>, cx) -> Result<bool, CommandError>;
    pub fn apply_external_source(&mut self, source: &str, origin: EditOrigin, cx) -> Result<MergeSummary, SharedString>;
    pub fn insert_at(&mut self, pm_pos: usize, text: &str, origin: EditOrigin, cx) -> Result<(), CommandError>;
    pub fn replace_range(&mut self, from: usize, to: usize, text: &str, origin: EditOrigin, cx) -> Result<(), CommandError>;
    pub fn track_changes(&mut self, round: RoundId);
    pub fn untrack_changes(&mut self, round: RoundId, cx);
    pub fn tracked_changes(&self, round: RoundId) -> Vec<TrackedChange>;
    pub fn set_change_gutter(&mut self, g: Option<(RoundId, Hsla)>, cx);
    pub fn change_gutter_bars(&self) -> Vec<(BlockId, Bounds<Pixels>)>;
    pub fn set_search(&mut self, query: &str, case_sensitive: bool, cx) -> usize;
    pub fn select_search_match(&mut self, index: usize, cx) -> bool;
    pub fn search_matches(&self) -> &[(BlockId, Range<usize>)];
    pub fn set_image_base_dir(&mut self, dir: Option<PathBuf>, cx);
    pub fn set_placeholder(&mut self, text: Option<SharedString>, cx);
    pub fn toggle_script(&mut self, sup: bool, cx);
}
// Read-only model API, via `state.model()`:
impl BlockEditorModel {
    pub fn frontmatter(&self) -> Option<&str>;
    pub fn prompt_widgets(&self) -> Vec<(BlockId, PromptWidget)>;
    pub fn find_prompt_widget(&self, id: &str) -> Option<BlockId>;
    pub fn prompt_widget(&self, block: BlockId) -> Option<PromptWidget>;
    pub fn find_all(&self, query: &str, case_sensitive: bool) -> Vec<(BlockId, Range<usize>)>;
    pub fn pm_size(&self) -> usize;
    pub fn pm_from_position(&self, pos: BlockPosition) -> Option<usize>;
    pub fn position_from_pm(&self, pm: usize) -> Option<BlockPosition>;
    pub fn pm_selection(&self) -> Option<(usize, usize)>;
    pub fn pm_text_between(&self, from: usize, to: usize, block_sep: &str, leaf_text: Option<&str>) -> String;
    pub fn document_read_range(&self, from: usize, to: usize) -> DocumentRange;
    pub fn window_around_pos(&self, pos: usize, max_chars: usize) -> String;
    pub fn outline(&self) -> Vec<DocHeading>;
    pub fn nearest_preceding_heading(&self, pos: usize) -> Option<DocHeading>;
    pub fn changed_blocks(&self, round: RoundId) -> Vec<BlockId>;
    // plus mutating twins of the state methods (headless use and tests).
}
```

## Round 2 additions

- **Recursive merge.** `apply_external_source` diffs inside same-kind
  containers (lists, items, quotes, tables, rows) and edits text leaves
  (paragraphs, headings, code, table cells) in place at any depth, so ids,
  carets and tracked spans survive an agent edit inside a list item. Prompt
  widgets the new text dropped are kept at any depth (also when their
  container is replaced). The new bytes are adopted only when the edited
  block's content really equals the new one.
- **Change tracking.** A removed block leaves a zero-width deletion marker
  (where it was); text a join moves into another block keeps its span (also
  through undo/redo). Deletion markers paint a short tick next to the bar.
  Navigator: `change_stops(round)` (model), `change_count`, `change_index`,
  `step_change(round, forward, cx)` (wraps; moves the caret there, which
  scrolls; shows the round's gutter; the bar pulses ~0.9 s).
- **Diff card.** A ```` ```lang diff ```` fence renders as the editor's own
  card (file label from `+++`/`---`, language, `+N −M`, Edit, rows with
  gutter signs and added/removed backgrounds, hunk headers muted). A click
  (or the caret entering the block, e.g. with arrows) shows the source for
  editing; leaving it shows the card again. `set_diff_cards(false)` keeps
  the plain code block. `diff_summary(lang, code)` is public.
- **Trailing node.** `BlockEditorState` keeps an empty landing paragraph
  after a final code block, table, rule or widget (outside history; writes
  nothing while empty; merges ignore it). `set_trailing_paragraph(bool)`;
  off on a bare `BlockEditorModel`.
- **Properties panel.** A "Properties (n)" chip above a document with
  frontmatter (`set_properties_chip`) opens a key/value panel
  (`open_properties`, `close_properties(apply)`, `is_properties_open`):
  edit, remove, add rows; Done writes one undoable frontmatter change.
  Only single-line `key: value` lines are rows; comments, nested values and
  untouched lines keep their bytes (`parse_properties`, `apply_properties`).
- **Language picker.** With the caret in a code block, a language button
  sits at its top right; it opens the spec's language list
  (`CODE_LANGUAGES`); `set_code_language(Option<&str>)` keeps `diff`.
  `set_language_picker(false)` hides it.
- **Images.** `set_image_asset_target(Some(|| Some(ImageAssetTarget { dir,
  src_prefix })))`: a pasted clipboard image and dropped OS image files are
  written into `dir` (name normalized: spaces → `-`, parentheses removed,
  `-1`, `-2` de-duplication) and inserted as `![](src_prefix + name)` at the
  caret / drop point. Other dropped files are reported as
  `BlockEditorEvent::FilesDropped { paths }`. `drop_paths(paths, at, cx)`,
  `save_image_asset`, `normalize_asset_name` are public.
- **Drag handles for all top-level blocks.** A strip left of every
  top-level block (further left for lists, past their markers; widget node
  views too) shows the grip on hover and drags the block (one undo step).
  A plain click there still places the caret (tables and code blocks keep
  their click-to-select edge).
- **Style learning.** An edited list is written with its own markers
  (`*`/`+`/`-`, `1.`/`1)`); a new list uses the file's first bullet and
  ordered style.

### API delta (round 2)

```rust
// new re-exports
pub use notefig_view::{DiffSummary, diff_summary, ImageAssetTarget, normalize_asset_name, save_image_asset};
pub use notefig_ui::{CODE_LANGUAGES, Property, apply_properties, parse_properties};
// BlockEditorEvent gains FilesDropped { paths: Vec<PathBuf> }
impl BlockEditorModel {
    pub fn change_stops(&self, round: RoundId) -> Vec<(BlockId, BlockPosition)>;
    pub fn set_trailing_paragraph(&mut self, on: bool);
}
impl BlockEditorState {
    pub fn change_count(&self, round: RoundId) -> usize;
    pub fn change_index(&self, round: RoundId) -> Option<usize>;
    pub fn step_change(&mut self, round: RoundId, forward: bool, cx) -> Option<usize>;
    pub fn set_diff_cards(&mut self, on: bool, cx);
    pub fn set_trailing_paragraph(&mut self, on: bool, cx);
    pub fn open_properties(&mut self, window: &mut Window, cx);
    pub fn close_properties(&mut self, apply: bool, window: &mut Window, cx);
    pub fn is_properties_open(&self) -> bool;
    pub fn set_properties_chip(&mut self, on: bool, cx);
    pub fn set_code_language(&mut self, lang: Option<&str>, cx);
    pub fn set_language_picker(&mut self, on: bool, cx);
    pub fn set_image_asset_target(&mut self, t: Option<impl Fn() -> Option<ImageAssetTarget> + 'static>);
    pub fn drop_paths(&mut self, paths: &[PathBuf], at: Option<Point<Pixels>>, cx);
}
// node_view_bounds() now also lists diff cards (their code block's id).
```

## Round 3: performance and fidelity

### Measurements against the app's perf SLOs

Harness: `src/tests/perf.rs` runs the SLO scenarios of
`packages/desktop/tests/perf/editor.spec.ts` on a byte-exact port of
`largeDocument()` (8,000 lines, 439 KB, 2,663 top-level blocks, tables,
six widgets) in a real GPUI test window (800×900 px), each sample being the
action **plus a full frame** (`window.draw`). Run:

```sh
cargo test -p gpui-kit-markdown-editor --lib perf_ -- --ignored --nocapture
# editor at opt-level 1 like its dependencies:
cargo test --config 'profile.dev.package.gpui-kit-markdown-editor.opt-level=1' \
  -p gpui-kit-markdown-editor --lib perf_ -- --ignored --nocapture
```

Test platform (no GPU paint), Apple Silicon, deps at opt-level 1, no
`--release`. p50 / p95:

| SLO scenario (8k-line doc) | editor opt-level 0 | editor opt-level 1 | TS app today (spec §4.12) | GPUI target |
|---|---|---|---|---|
| caret-move (→ + frame) | 6.3 / 6.5 ms | **3.3 / 3.6 ms** | — | < 8 ms |
| caret-move (↓ + frame) | 6.3 / 6.5 ms | **3.2 / 3.3 ms** | — | < 8 ms |
| input (type a char + frame) | 8.8 / 10.3 ms | **3.4 / 3.7 ms** | p95 50 ms | < 8 ms |
| input-delete (Backspace + frame) | 8.7 / 9.6 ms | **3.4 / 3.5 ms** | — | < 8 ms |
| select-all (+ frame) | 16.7 / 17.2 ms | **5.2 / 5.6 ms** | p50 66–74 ms | — |
| select-all-caret-move | 5.9 / 6.2 ms | **2.4 / 2.5 ms** | — | — |
| scroll frame (450 px step) | 3.3 / 4.3 ms | **1.7 / 2.7 ms** | — | < 8 ms |
| steady frame | 3.2 / 3.3 ms | **1.6 / 1.6 ms** | — | — |
| agent merge, one-line change (model) | 11.2 / 20.7 ms | **2.2 / 10.5 ms** | — | — |
| agent merge, streaming append (+ frame) | 13.4 / 14.5 ms | **3.2 / 3.3 ms** | — | — |
| `source()` after an edit (autosave) | 1.2 ms | 0.23 ms | — | — |
| open, synchronous (`set_source` + first frames) | 655 ms | 625 ms | — | — |
| open, `set_source_async`: first frame | 29 ms | **19 ms** | — | — |
| open, async: whole document in | 488 ms | 437 ms | — | — |

Before this round (opt-level 1): typing 23 ms p50 (p95 26), caret 15.7 ms,
steady frame 7.8 ms, open 1.05 s, one-line merge 14 ms, and merges re-parsed
the whole file (134 ms at opt-level 0). The widget SLOs (`widget-input`,
`widget-caret-move`) are app-side now (the draft is the app's input
entity). The workspace-open SLO is not the editor's.

**Recommendation for the app:** add
`[profile.dev.package.gpui-kit-markdown-editor] opt-level = 1` to the
workspace `Cargo.toml` (I did not touch it): it takes typing from 8.8 to
3.4 ms on the 8k doc. The remaining open cost is markdown-rs itself
(`parse_markdown` = 402 ms of the 403 ms parse at opt-level 1; release
builds are several times faster); use `set_source_async` for large files.

### What changed for performance

- **gpui-kit quadratic retained-layout sweep (found by sampling).**
  gpui-kit keeps the layout of every laid-out inline state that is still
  alive in a thread-local map and sweeps the whole map on *every* insert
  once it holds 4,096 entries. The editor's projection cache kept every
  block it ever laid out alive, and the first frame laid out all 2,663
  blocks, so every later frame paid ~4,500 checks per laid-out line.
  Fixes: (a) a frame with no known viewport (first frame, resize) lays out
  only the first ~4,000 px when the document has more than 600 cull units
  (estimates stand in for the rest); (b) after 300 distinct top-level blocks
  have been laid out, the projection of every block off screen is evicted
  (re-projected cheaply when it scrolls back). Upstream gpui-kit should
  sweep by age, not on every insert.
- **Incremental external merge.** `apply_external_source` first compares
  the new text with what the document writes now (chunked common
  prefix/suffix), widens the changed bytes to whole top-level blocks (one
  block of context each side, never splitting next to a list), checks the
  region can be parsed alone (balanced fences and HTML comments, no link
  definitions, blank-line separation, nothing indented after it) and
  re-parses only that region; every other block keeps its id and its bytes
  are re-anchored in the new text. Otherwise it falls back to the full
  parse. Identical bytes return at once. `MergeSummary::incremental` says
  which path ran. Verified against a full re-parse over 40 random edits of
  the 8k doc plus streaming appends (exact bytes and identical structure).
- **Per-keystroke work is O(changed).** Normalization runs only after
  structural steps; the O(document) invariant check runs only on documents
  under 2,000 blocks in debug builds; the projection snapshot reuses its
  block list, table map and index when the structure did not change; the
  top-level index lookup no longer scans; block maps use a cheap id hasher
  instead of SipHash; a block's canonical form (for byte preservation) is
  computed lazily before its first edit instead of for every block at open.
- **Open.** `set_source_async(source, cx)` shows the first ~24 KB at once
  (read-only), parses the whole file on a background thread and swaps it in
  (`BlockEditorEvent::Loaded`).

### Fidelity

- **PM positions with images match TipTap.** A paragraph holding images is
  counted as TipTap's schema has it, `p(text) image p(text)`, with edge
  whitespace dropped as PM's DOM parser does; `pm_size`,
  `pm_from_position`, `position_from_pm`, `pm_text_between` and
  `document_read_range` follow (an image is a block leaf: it gets the block
  separator and `leaf_text`).
- **Edited blocks follow the file's style:** emphasis delimiters (`_x_` /
  `__x__` when the file prefers them, never inside a word, where `*` is
  kept), list markers (round 2), and tables: outer pipes, cell spacing,
  column padding (re-padded to the new widths when the original was
  aligned), and the original delimiter row when the alignments did not
  change.

### API delta (round 3, additive)

```rust
pub struct MergeSummary { /* … */ pub incremental: bool }   // new field
// BlockEditorEvent gains: Loaded
impl BlockEditorState {
    pub fn set_source_async(&mut self, source: String, cx: &mut Context<Self>) -> gpui::Task<()>; // detach it
    pub fn is_loading(&self) -> bool;
}
```
Behaviour changes, no signature changes: PM positions in paragraphs with
images; emphasis and table style of edited blocks.

## Gaps against spec 01, ranked (most important first)

1. **Edited blocks are not byte-identical to prosemirror-markdown.**
   Untouched blocks are exact; list markers, emphasis delimiters and table
   layout follow the file; escapes, `<br>` in marked text and hard-break
   form still use the fork's canonical form. Only edited blocks can differ.
2. **Prompt draft is not document content** (no `ContentSlot`): the app
   hosts the draft; draft-only-edit, draft caret restore and draft carry
   over adoption are app-side. Widgets nested in list items render as a
   muted label (top-level ones get the node view).
3. **Merge pairing is positional** inside a run of changed siblings (1:1 in
   order), so a reorder plus edit can pair the wrong blocks (still correct
   output, just more ids replaced). O(n) re-parse + diff per merge.
4. **Change tracking** has no fingerprint persistence (the app stores spans
   and restores them) and the deletion-marker anchor is computed after the
   whole transaction (approximate when one transaction removes and inserts
   around the same place).
5. **Images are inline atoms** in the model (TipTap: blocks); PM
   positions now count them as TipTap does, but editing still treats them
   as inline (no paragraph split on insert).
6. **sub/sup are atoms**, not marks (gpui-kit's `TextMark` has no field).
7. **Diff card**: unified only (no side-by-side), no collapse, no Shiki
   colours inside the card, no file-link resolution.
8. **Not built:** minimap, dictation ghost, table column resize; frontmatter
   panel edits only single-line scalars.
9. **Not verified on screen in this session** (no display access): cards,
   panel, picker, handles, gutter and placeholder are covered by window
   tests (layout, bounds, events, clicks), not screenshots.
10. Keymap has no priorities/fallthrough beyond GPUI contexts; IME,
    spellcheck and accessibility as upstream.

## Files

`src/source_map.rs` (preserving serializer, frontmatter split),
`src/notefig.rs` (syntax, widgets, mentions, scripts, search),
`src/notefig_view.rs` (entity API, node views, slash, gutter, search,
placeholder, shortcuts, diff card, images), `src/notefig_ui.rs`
(properties panel, language picker), `src/merge.rs`, `src/pm.rs`, `src/tracking.rs`,
plus hooks in `import.rs`, `serialize.rs`, `markdown_source.rs`,
`step.rs` (`SetFrontmatter`, `SetSourceMap`), `transaction.rs`
(`External`/`Agent` origins), `editor.rs`, `state.rs`, `element.rs`.
