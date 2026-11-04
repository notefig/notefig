# notefig-app

The Notefig app shell on GPUI + gpui-kit 0.8.0: binary `notefig`, the
composition root. Filesystem and persistence live in
[`notefig-workspace`](../notefig-workspace) (no gpui); the markdown editor is
[`markdown-editor`](../markdown-editor).

## Run

```sh
cd gpui-spike
cargo run -p notefig-app -- ~/notes     # open a folder
cargo run -p notefig-app                # restore the last workspace, or Welcome
cargo test -p notefig-app -p notefig-workspace
```

- App state: `~/Library/Application Support/com.notefig.gpui/state.json`
  (`NOTEFIG_STATE_DIR=<dir>` overrides the folder).
- Logs: warnings to stderr; `NOTEFIG_LOG=info|debug` for more.

## What works

- **Welcome**: Open Folder… (`cx.prompt_for_paths`), recent workspaces (open,
  remove). Launch restores the last workspace; `notefig <path>` opens a folder.
- **Window chrome**: gpui-kit `TitleBar` with transparent titlebar and
  traffic lights; title shows workspace / active file / dirty dot. Window
  bounds (and maximized/fullscreen) persist and restore.
- **Notefig look** (`theme.rs`, `assets/notefig-theme.json`): the app's CSS
  tokens (shadcn "stone" + terracotta brand, spec 04 §8) as a gpui-kit
  light/dark theme pair; brand/success/warning/highlight via
  `theme::BrandColors`. Inter and Libre Baskerville are bundled
  (`assets/fonts`, OFL) and Inter is the UI/document font. Theme follows the
  OS (`System`), or Light/Dark via View → Theme, the palette, or the rail
  button; persisted.
- **Sidebar rail**: Files, Search and Sessions views, theme toggle; collapse
  (Ctrl+Cmd+S, or click the active rail icon); width resizable and persisted.
- **Files tree** (`uniform_list`, virtualized): folders first, expand/collapse
  persisted per workspace, file icons, active/selected highlight, click =
  preview tab, double-click / Cmd-click = pinned tab, context menu (Open, Open
  to the Side, New File…, New Folder…, Rename…, Delete, Reveal in Finder),
  inline create and rename (Enter/blur commits, Escape cancels; files without
  an extension get `.md`), delete with a native confirm (moves to Trash via
  NSFileManager), drag a file onto a folder to move it, drag a file onto a tab
  bar to open it there, Reveal Active File (Cmd+Shift+E shows Files).
  Ignore rules match the TS app: `.gitignore`, hidden files except
  `.notefig/scratchpads`, the dependency/build folder denylist and binary
  extensions.
- **Search** (Cmd+Shift+F, `search_view.rs` over `Workspace::search`):
  workspace full-text search ported from the Tauri `search_content` command
  (grep-searcher/grep-regex; literal or regex, case toggle, binary files and
  the ignore rules skipped, 1000-result cap). Debounced 250 ms, cancellable,
  results stream in per file, grouped and collapsible, with the match
  highlighted. Clicking a match opens the file (preview tab) at the match:
  code files move the cursor to line/column; markdown selects the same
  occurrence of the matched text in the editor (no source mapping yet).
- **Scratchpads** (`notefig_workspace::scratchpads`, MET-135): Cmd+N creates
  `.notefig/scratchpads/<adjective-noun>.md` and opens it. Entering a
  workspace (Open Folder, a recent, `notefig <path>`; not the restore at
  launch) sweeps abandoned whitespace-only scratchpads not open in a tab, and
  with no file tab open lands on the most recent scratchpad or a fresh one.
  `.notefig` and `.notefig/scratchpads` cannot be renamed, deleted or
  dragged.
- **Tabs and splits** (own model in `layout.rs`, pure + unit-tested): panes in
  nested row/column splits with resize handles (sizes persisted per split), preview vs pinned tabs (editing pins), select,
  close (button, middle-click, Cmd+W), drag to reorder or move to another
  pane, Cmd+\ split right, Cmd+Alt+\ split down, Ctrl+Tab / Ctrl+Shift+Tab,
  Cmd+[ / Cmd+] pane focus. Layout, focused pane, expansion and sidebar state
  persist per workspace and restore on launch (tabs of missing files dropped).
- **Documents**: `.md`/`.markdown`/`.mdx` host `BlockEditorState` in a scroll
  container; other text files open in gpui-kit's code editor (`EditorState`,
  line numbers, syntect highlighting by extension); images preview; binary or
  >5 MB files show a message. One `Document` per file, shared by panes.
- **Autosave**: 500 ms after the last edit, one write in flight (a second save
  queues), dirty dot on the tab and title until the write lands; Cmd+S saves
  now; unsaved edits are written on quit and on workspace close.
- **Watcher**: `notify` + 100 ms debounce, own-write echo suppression by
  content hash, rename pairing. External content goes through
  `document::apply_external_content(editor, new_source)`; renames and
  deletes update tabs; the tree rescans in the background.
- **External change vs unsaved edits** (TS DocumentSync, spec 01 §2.4):
  same text up to trailing whitespace is a no-op; while the user has unsaved
  edits (debounce pending, write in flight, dirty) the external change is not
  adopted and the user's save overwrites it (forced even if a write was in
  flight); otherwise the new content is adopted.
- **Palettes**: Cmd+P quick open (nucleo fuzzy over workspace files, open
  tabs first), Cmd+Shift+P command palette over app actions; ↑/↓/Enter/Esc.
- **Commands/menus**: Cmd+N new scratchpad, Cmd+O open folder, Cmd+S, Cmd+W, native menus (File/Edit/View with Theme submenu).

## Verified

- `cargo test -p notefig-workspace` (15): rules, containment incl. symlink
  escape, read/write/hash, scan rules, create/rename/delete, own-write echo
  suppression, rename pairing, a live `notify` watcher round trip, state
  JSON round trip and corrupt-file recovery, search (literal/regex/case,
  char columns, ignore rules, cap), scratchpad create/sweep/enter.
- `cargo test -p notefig-app` (19): also search (Cmd+Shift+F, debounce,
  streamed grouped results, opening a match selects that occurrence),
  unsaved edits winning over an external change and later adoption,
  scratchpad landing and Cmd+N, protected scratchpads folder, Notefig theme
  pair + saved window bounds, split sizes surviving serialization; layout/tree/fuzzy unit tests plus gpui
  window tests over the real view tree (`TestAppContext`/`VisualTestContext`,
  inside gpui-kit's Root): open workspace + file in a tab (markdown and code),
  preview tabs and reveal, typing + autosave writes disk after the debounce,
  Cmd+S, Cmd+P quick open, Cmd+Shift+P command, external write reloads the
  editor without writing back, inline folder rename and on-disk rename/delete
  update tabs, Cmd+N and inline create, split + layout/expansion restore in a
  fresh app on the same state file, theme toggle persisted.
- At runtime the log confirms Inter and Libre Baskerville register with the
  text system.
- The binary boots against a fixture folder (Welcome, CLI path, and restore
  of a saved split layout with markdown, code, image and chat tabs) and stays
  up with no panics; screenshots are not possible from this terminal (no
  Screen Recording permission), so the visuals are unreviewed.

## Gaps vs spec 04

- Persistence is a JSON file, not SQLite; no import of the Tauri app's
  `notefig.db` (recents, settings, session `lastSearch`).
- One workspace at a time: no open set / workspace chips / switcher, no
  close-workspace confirm for live agents, no access-error recovery.
- Sidebar: no Everything or Git views; Sessions is a placeholder. No
  collapse animation, no RTL. Search has no file-include filter, context
  lines or replace.
- Tree: no sort modes (date), no keyboard navigation/type-ahead, no
  multi-select, no external file drops, no image drop placement; protected
  scratchpads dir is not enforced.
- Dock: no drag-to-edge splitting (drop onto a tab bar only), no Mod+1…9, no
  tab drag between windows.
- Scratchpads: no "scratchpad on startup" setting (landing is always on);
  the sweep does not yet treat prompt-widget-only files as empty.
- External changes are adopted whole (`set_source`), not diffed; no widget
  re-assertion. A save in flight during a rename can recreate the old path.
- Theme: no Rubik (Hebrew/Arabic) font, no noise texture or "floating
  cards" shell, no 1.5x UI scale; the token mapping onto gpui-kit slots is
  approximate and unreviewed visually.
- Not started: settings modal, zoom levels, tray status item, updater, telemetry,
  feedback, tunnel, dictation, project settings (`metrists.json`), recent
  documents, perf SLO harness.
- Key differences from the TS app: Cmd+\ is split (TS: toggle sidebar, here
  Ctrl+Cmd+S); Cmd+K is not the palette (the editor uses it for links).

## AI (agents) — `src/agents/`

Boot: `Agents::boot_default(state_dir)` in `main.rs` starts `AgentHost`
with a `JsonFileStore` (`<state dir>/agents.json`), `ChannelServices`
answered on the UI thread, and `RelayCommand::app_exe(current_exe)`;
`notefig --mcp-stdio-relay <port>` runs `notefig_agent::mcp::relay_main`.
`NOTEFIG_NO_AGENTS=1` skips it. `Agents` (an entity, on
`AppState::agent`) drains `AgentEvent`s in batches (one notify per drain),
keeps a version per task so chat views re-read only their task, and maps
widget turns to editor `RoundId`s. On quit the host shuts down (children
killed).

- **ClientServices** (`agents/services.rs`): `fs/read_text_file` = live
  editor text when open, else disk (line/limit); `fs/write_text_file` =
  disk write (echo suppressed) then the editor adopts it through
  `apply_external_source(.., EditOrigin::Agent{round})` — one undo step;
  unsaved user edits win, as in TS. MCP tools: `workspace_list_documents`,
  `workspace_read_document`, `workspace_open_files`, `document_read_range`
  (live editor model, else parsed from disk), the widget-context resource
  (title, outline, heading, surrounding text, selection, other open files).
  `widget_respond` is handled in the agent crate. `history_*` run on the
  background executor against the workspace's history repo;
  `history_restore` writes through the adopting write.
- **External content**: `document::apply_external_content(editor, text,
  origin)` is the one path (watcher reloads `External`, agent writes
  `Agent{round}` via turn-write attribution). A write whose turn is a
  widget round starts change tracking + gutter bars; `reinserted_widgets
  > 0` writes `source()` back.
- **Sessions panel** (rail → Sessions, Cmd+Shift+A): the workspace's tasks
  by `updatedAt` with status glyphs (sign-in > asking dot > pulsing orb >
  hairline ring), `+ New <harness> session` (last used, else first
  pickable) and a harness picker; first session asks to trust the
  workspace (native confirm). Cmd+Alt+N / palette "New Session".
- **Chat tab**: virtualized transcript (`gpui::list`, follows the tail,
  spliced from the first changed item): user bubbles with Queued badge
  (remove from queue) and per-turn usage, assistant markdown (gpui-kit
  `TextView`), collapsible thoughts, plan, tool-call cards (status, kind,
  location chips that open files, diff header +N −M with preview rows,
  content text, terminal placeholder; click expands), turn errors,
  permission card (ACP options, emphasis by kind), auth card (methods,
  hint, "I've signed in"), unavailable card (copy resume command, delete),
  "Working…" row. Composer: Enter sends (queues while busy), Stop,
  Escape = cancel-and-forget (restores the prompt), `@` file mentions with
  a suggestion list, `@model:x` / `@effort:x` / `@skill:x` directives,
  config bar (model + effort selects from the session's options), context
  fill meter and session cost.
- **Prompt widget** (`agents/widget.rs`): `/` in an empty paragraph inserts
  a widget (editor `SlashTrigger` → `insert_prompt_widget`) whose node view
  hosts its own composer (mentions, directives). State machine ported from
  `machine.ts` (`state_from_round`, unit-tested): composing{confirmingTrust}
  → sending → working{queued|running} → asking{permission|auth|question} →
  settled{done|error|cancelled}. Send binds the widget to the workspace's
  shared session (`shared_session`, marker written), `prompt_from_widget`
  (widget-context resource link), `record_round_started`; the answer is the
  round outcome (`widget_respond`: answer / issue / single & multiple choice
  as numbered buttons, a choice replies), touched-file chips open the file
  and step the change navigator; tracked spans are saved as review ranges
  when the round settles. A bound widget picks its newest persisted round
  back up on reopen. Stop, Escape, remove (×).
- **Document wiring (editor round 2)**: images pasted/dropped go to
  `assets/` next to the document, other dropped workspace files become
  mentions, diff cards + properties chip + language picker on, links open
  files or URLs, "Next/Previous Change" (Alt+F5 / Alt+Shift+F5, palette)
  steps the document's latest agent round.
- **Settings tab** (Cmd+,): harnesses (found/missing/unchecked dot + path,
  edited badge, enable switch, inline edit of command/args/env → override
  or custom entry, add custom, remove custom, rescan) and usage for the
  last 14 days by day and harness (tokens bar, cost).

## History — `src/history.rs`

Per workspace a `GixHistoryRepo` (`<ws>/.notefig/.git`) behind
`WorkspaceHistory`: status + log(100) on the background executor,
single-flight refresh with a generation guard, `git:stale` = watcher batches
and document saves (500 ms debounce). Sidebar "History" panel: the four
states (uninitialized → Initialize, error → Retry/Repair, empty, ready),
Save commit (+ chevron for a "What changed?" description), rows with
relative time, author, Latest badge, hash (click copies), Restore (reverts
that commit after a WIP checkpoint; disabled for the latest), revert banner
(MergeRequired → Abort revert). A checkpoint is taken after every
`TurnCompleted` (`turn_checkpoint`, author = harness).

## Verified (agents, history)

- `src/tests_agents.rs` over a fake ACP agent (in-process, loopback, via
  `TransportFactory`): chat send → transcript (user, thought, assistant
  markdown, tool card, per-turn usage); `fs/write_text_file` adopted into the
  open editor, file on disk, not dirty, Cmd+Z restores the old text;
  permission card answered → the agent sees the option; MCP
  `workspace_open_files` / `workspace_list_documents` from live state;
  `/` → widget → trust gate (first Send) → round → single-choice question
  → reply "Blue" → settled done, marker in the document.
- `history_panel_initialize_save_restore`: initialize, save, turn
  checkpoint (author = harness, message = prompt), restore reverts the
  agent's change, the user's `.git` untouched.
- **Live, claude-code** (`cargo test -p notefig-app --lib live_ --
  --ignored --nocapture`, needs `target/debug/notefig` for the relay):
  a chat prompt edited `a.md` (claude-agent-acp writes files itself →
  watcher → attributed adoption) and the open editor showed it in 8.8 s;
  the transcript had the tool card; Cmd+Z reverted the editor to the
  original text. A `/` widget round with "answer with widget_respond …
  pong" settled Done in 22 s with a `widget_respond` answer through
  `notefig --mcp-stdio-relay` → app MCP → widget-context resource read.
  (Two paid turns, a few cents.)
- The binary boots with agents on (install probe wrote harness rows to
  `agents.json`), no child processes left after exit.

## Integration points

- `Agents` (`agents/mod.rs`): `Agents::global(cx)`, `handle`,
  `task_version`, `origin_for`, `register_workspace`, `history`.
- `WorkspaceView::{open_tab(Tab::Chat{..}), chat(id), new_session,
  open_settings, open_changes, step_change, history}`.
- `history::HistoryRepos` maps workspace roots to repos for the tools.

## Gaps (AI, history)

- Chat: no scroll-to-end button, no spend-breakdown popover behind the
  context meter, no cmdk filter for long option lists (a scrollable menu
  instead), no special rendering of widget tool calls in the transcript,
  no composer draft persistence across restarts, no `@skill:` / `@model:`
  completion (they are parsed when typed), terminal output not shown.
- Widget: no `ContentSlot` (the draft is not document content), no draft
  carry-over across an external merge, no caret restore into drafts, no
  "Edit" of a sent prompt, no orphan/stale-turn UI beyond falling back to
  composing; persisted review ranges are saved but not restored on reopen
  (the editor's `restore_tracked_changes` is model-only); no minimap marks.
  A file chip steps changes only if the file was open when the agent wrote
  (tracking happens at adoption).
- Agent writes while the user has unsaved edits are not adopted (TS rule):
  the user's save overwrites them; no conflict UI.
- Settings: no harness logos, no probe/resume command fields, no usage
  ranges/grouping/charts/limit windows (a 14-day table only).
- History: no per-checkpoint diff view, no "auto-save commits" switch, no
  sync badge; the anti-flicker freeze keeps the previous state while
  fetching; status is computed with gix on every refresh (not benchmarked
  on large workspaces).
- Observed live: in the widget round the model saw the prompt text run
  into the widget-context URI ("pongnotefig://widget-context…"): the text
  block and the `resource_link` are adjacent without a separator by the
  time claude-agent-acp flattens them — worth a newline in the agent
  crate's `widget_prompt` / `compose_prompt`.
- No menu-bar status item, no Everything view, no tunnel/web locus.

## Requests to editor

- `restore_tracked_changes` on `BlockEditorState` (it is model-only), so
  persisted review ranges can be restored when a document reopens.
- A `MergeSummary` that says whether the merge touched the caret block,
  so an agent write can avoid moving a user's caret.
