# Spike 03 — Git client, history and diff UI

Source of truth: `/Users/parsa/Documents/notefig-gpui` @ `4a6555c1` (main). Paths below are relative to `packages/`.

## 0. Headline: this is not a git client

Notefig does not ship a general git client. It runs a **hidden, app-owned "document history" repo**
(gitdir `<ws>/.notefig/.git`, worktree = the workspace) used as a checkpoint timeline. The user's own
`<ws>/.git` is deliberately never read, staged or committed to (`desktop/src/modules/git/git.ts` header,
`git/src/git/dualRepoIsolation.integration.test.ts` "kernel methods must not fall back to the user's .git").
The only thing the app writes into the user's repo is one line, `.notefig/`, in `<ws>/.git/info/exclude`
(`desktop/src/modules/history/history.ts` `initialize`, `desktop/src/utils/git-exclude.ts`).

So the port is: a small, embedded, git-format snapshot store + one sidebar panel + three agent tools +
an unrelated (non-git) diff-card renderer. Port scope is much smaller than "Zed's git panel".

## 1. Operations the app actually performs

`GitService` (`git/src/git/types.ts`) has 18 methods; the app calls 8. Implementation:
`git/src/git/isomorphicGitService.ts` (isomorphic-git 1.37.x).

| Op | Impl (isomorphicGitService.ts) | App callers |
|---|---|---|
| `init({defaultBranch:"main"})` | hand-writes HEAD/config/description/info/exclude + dirs, then `git.init`; tolerates "already exists" | `history.ready()` → panel "Initialize/Repair commit history", every checkpoint, every agent tool |
| `status()` | `currentBranch` + `statusMatrix` (whole-worktree walk + hash) → staged/unstaged/untracked/conflicts; then re-filters untracked through `isIgnored` with explicit gitdir (upstream isomorphic-git bug: statusMatrix ignores the custom gitdir's `info/exclude`), with a per-burst read memoizer | `fetchGitRows` (every refetch), `addAllAndCommit` (twice), `revertTo` |
| `log({depth})` / `log({filepath})` | `git.log` | panel: depth 25 (`CHECKPOINT_LOG_DEPTH`, ~3.3 ms/commit measured); agent `history_log` with optional path filter, unbounded depth |
| `addAllAndCommit` | status → `add` each untracked/modified, `remove` each deleted (skipping already-staged) → status again → `commit`; returns `null` if nothing to commit | panel "Save commit", `history.checkpoint` (turn-completed hook + `history_checkpoint` tool), WIP commit before revert |
| `revertCommit({oid})` | **hand-rolled single-commit revert**: `listFiles` of parent/commit/HEAD, per-path blob oids, conflict iff HEAD blob ∉ {parent, commit} → `MergeRequired`; else per-path `checkout(parent, filepaths, force, noUpdateHead)` + add/remove, then commit `Revert <hash7>` | panel "Restore commit" via `WorkspaceGit.revertTo` |
| `abortRevert()` | `checkout HEAD --force` of the **whole worktree** (discards uncommitted changes; safe only because `revertTo` WIP-commits first) | revert banner "Abort revert" on `MergeRequired` |
| `readTextFile({ref, filepath})` | `readBlob` → UTF-8 decode | agent `history_restore` (then `documents.write`, so open editors update) |
| `add`/`remove`/`commit` | thin wrappers, `cache` shared | internal to the above |

Present but **dead** (no caller in `desktop/src`; do not port): `unstage`, `listBranches`, `createBranch`,
`switchBranch`, `checkoutPaths`, `fetch`/`pull`/`push` (throw `UnsupportedOperation` "not implemented in v1").
No auth, no remotes, no credentials anywhere. `ahead`/`behind` are never populated by `status()`, so the
panel's "Not synced" badge state (`deriveSyncState`, git.ts) is unreachable. Error codes `AuthRequired`,
`AuthFailed`, `LockUnavailable` are never produced (`toGitError` maps NotFound→`RepoNotFound`,
FastForward/PushRejected→`NotFastForward`, everything else→`CorruptRepository`).

Semantics worth knowing before porting:
- "Restore commit" in the panel is **`git revert <that commit>`** (inverse of one commit), not "reset the
  tree to that checkpoint", despite the label. Disabled for the newest row. Preserve or fix deliberately.
- Commit identity: panel saves as `Notefig <git@notefig.com>` (`COMMIT_AUTHOR`); turn checkpoints as
  `<harnessId> <agent@notefig.local>`; tool checkpoints as `agent <agent@notefig.local>`. Message = prompt
  truncated to 72 chars (`checkpointMessage`, history.ts).
- History exclude (`HISTORY_EXCLUDE_LINES`): `.notefig/*`, `!.notefig/scratchpads`, `.git/` — scratchpads are
  versioned, the rest of the app dir and the user's gitdir are not. Storage host walks with `includeHidden`
  and no ignore rules, so this exclude + the workspace's `.gitignore`s are the only filters.
- Symlinks/chmod unsupported (`git-storage-host.ts` throws); mode is synthesized `0o100644`/`0o040755`;
  `ino/dev` faked to 1, `ctime=mtime` (`isomorphicGitFs.ts`).
- Locks: in-process `Set` keyed `<gitDir>::<name>` (git-storage-host.ts). isomorphic-git **ignores
  system git's `index.lock`** (documented in `realGit.concurrency.integration.test.ts`). No cross-process
  locking at all.
- Interop is tested against system git: `realGit.interop.integration.test.ts` (init/commit/revert readable by
  `git`, `fsck --full` clean), concurrency test (interleaved app + CLI commits, no corruption).

## 2. Where it runs

```
main thread                                   git Web Worker (desktop/src/workers/git.worker.ts)
core.workspace(ws).git  (modules/git)         startGitWorker (git/src/git/workerRuntime.ts)
  └ history.service()   (modules/history)       └ createGitWorkerApi: Map<gitDir, IsomorphicGitService>
      └ GitWorker.create(repo) ──gitCall RPC──►       (object cache per repo, lives until disposeRepo)
        (modules/git-worker, @notefig/worker)            └ GitStorageHost (adapters/git-storage-host.ts)
  serveWorkerHost(fs) ◄──── host-RPC per fs op ──────────── createHostClient<GitHostFs>
  platform.fs: Tauri invoke (Rust fs_ops.rs) | FS Access API | IndexedDB `metrists-fs`
```
- Same JS code path on Tauri and browser. CPU (SHA-1 hashing, inflate, packfile parse, index rewrite) is in
  the worker; **every fs op round-trips worker→main→(Tauri IPC→Rust)**. `stat` is the hottest op; one
  `getMetadata` per call (pre-flight removed for IPC cost). `readDir` returns types to avoid a second pass.
- Boot: lazy, one worker for all repos; init handshake pins `__NOTEFIG_DESKTOP_OS__` before path utils load.
  Dead worker → handle dropped, next call reboots; no inline fallback (git-worker.ts header).
- Errors cross as data (`GitBoundaryError` kind git/fs/unknown, `workerBoundary.ts`); `FsError` revived so
  workspace-access loss reaches `WorkspaceErrorBoundary`.
- Browser polyfills: `Buffer` in worker; `desktop/src/polyfills/node-crypto.ts` shims `crypto.createHash("sha1")`
  for packfile reads (without it any packed repo shows "needs repair").
- No git in Rust today: `src-tauri` has no git crate; `file_watcher.rs`/`walkdir_utils.rs` only filter
  `.notefig/.git` and `.git/` paths out of watcher events and tree walks.

## 3. Data model, caching, invalidation

`modules/git/git.ts` — one TanStack DB query collection per workspace, key `["git", normalize(ws)]`
(also hand-inlined by `hooks/use-debug-snapshot.ts` / `utils/debug-report.ts`):
- `repo` row: `branch`, `ahead?`, `behind?`, `initialized` (false ⇔ status `RepoNotFound`), `statusError?`, `logError?` — errors as data.
- `file:<abs path>` rows: `staged/unstaged/untracked/conflicted` flags (repo-relative → native absolute).
- `cp:<oid>` rows: `oid`, `hash` (7), first line of message (or "Commit"), committer timestamp ms.
- One `queryFn` (`fetchGitRows`) = status + log(25). `staleTime: 2s`, `retry: false`, no mutation handlers
  (optimistic pending row stranded ghosts on @tanstack/db 0.6.1 — pending row is UI-only; MET-125).
- Only workspace-access errors escape the queryFn.

Invalidation (`git:stale` in `CoreHookMap`):
- Emitted by `files.changed()` debounced **500 ms** (`modules/files/files.ts` `invalidateDerived`, called from
  watcher-driven `file-sync.ts` and app writes), and by `history.checkpoint()` (commit into the hidden gitdir,
  which the watcher filters).
- Listener in `gitModule.workspace.create` → `queryClient.invalidateQueries` if `workspaceKey` matches.
- Writes: `saveCheckpoint` first `cancelQueries` (stale pre-commit fetch must not land after), then commit,
  then refetch in `finally`. `revertTo`/`abortRevert`/`initialize` refetch after.
- Object cache: isomorphic-git `cache` object per service for its lifetime (avoids re-parsing pack indexes —
  the "multi-second first-status stall"); dropped on `RepoNotFound`/`CorruptRepository`; `disposeRepo` on close.
- Lifetime: `history.dispose` → `gitWorker.dispose(gitDir)`; `git.dispose` → `removeQueries`. History is
  disposed after agents (`workspace-agents.ts needs: [historyModule]`) so a cancelled turn can still checkpoint.

## 4. UI surfaces and states

### 4.1 Checkpoint panel — `desktop/src/components/editor/git/checkpoint-panel.tsx`
Mounted as sidebar tool `"git"` (`modules/sidebar-view/sidebar-view.ts WORKSPACE_TOOLS`, `components/editor/sidebar.tsx:309`).
- Toolbar: split button "Save commit" (disabled unless `hasChanges` and initialized; "Saving commit…" while
  pending) + chevron popover (title, hint, textarea "What changed?", Save, **disabled** "Auto-save commits"
  switch); sync badge: Unchecked (`CircleDashed`) / Not synced (unreachable) / Synced (`Check`).
- `PanelState`: `uninitialized` (initialized=false & no rows → message + "Initialize commit history"),
  `error` (initialize/status/log error → code-specific title/message + Retry / Initialize / Repair),
  `empty` ("No commits yet…" + Save), `ready` (list).
- Anti-flicker: `useStablePanelState` freezes the rendered state while a background fetch is in flight (`useGitFetching`).
- Row: message (or relative time via date-fns) · "Latest" badge on index 0 · mono 7-char hash (click = copy) ·
  Restore (`Undo2`, tooltip) disabled for latest/pending/while reverting. Pending-save row prepended while saving.
- Revert banner: `MergeRequired` → "Revert needs attention" + "Abort revert"; other errors → Dismiss.
- All strings i18n (`timeline*`, `saveCheckpoint*`, `restoreCheckpoint`, …).
- No per-checkpoint diff view, no file list, no staged/unstaged UI (file rows only feed `hasChanges`), no branch UI.

### 4.2 Agent tools — `desktop/src/modules/agents/tools/history-{log,checkpoint,restore}.ts`
`history_log(path?)`, `history_checkpoint(message)`, `history_restore(path, checkpoint)` (requires permission;
writes through `documents.write`). Reached via `ctx.services.history`.

### 4.3 Diff cards (not git-backed) — `widgets/src/diff-block/*`, `desktop/src/modules/diff-blocks/diff-blocks.ts`
Renders ```` ```<lang> diff ```` fences in docs/chat and agents' edit tool calls (`transcript.tsx`). Patch built
with jsdiff `createTwoFilesPatch` from ACP `oldText/newText` (`patch.ts patchOf`, excerpt line offset),
parsed/rendered by `@pierre/diffs` + Shiki in a shadow root. Header: file icon, workspace-relative label (link
opens a tab), +/− counts. Side-by-side when both sides exist and lines ≤80 cols else unified; wraps, never
h-scrolls; collapsible, lazily builds the diff only when open; keyboard controls with digit hints
(`diffControls`). This belongs to the editor/agents spikes for rendering, but shares a hunk engine with any
future checkpoint diff.

## 5. Perf notes (current)
- Cold `status` on a large packed repo: ~20 s first statusMatrix (packfile parse) — comment in git.ts; history
  repos are usually small/loose, but a big workspace means `statusMatrix` hashes every unstaged-looking file
  over per-file IPC. This is the dominant cost and the main thing native Rust fixes outright.
- log: ~3.3 ms/commit → depth capped at 25 for the panel.
- Turn checkpoint = status ×2 + N adds + commit, all over IPC, after every agent turn.
- Watcher-driven refetch storms bounded by the 500 ms debounce + 2 s staleTime.

---

## 6. Rust / GPUI port

### 6.1 Backend choice

| | gix (gitoxide) | git2 (libgit2) | shell `git` |
|---|---|---|---|
| Status (index↔worktree + tree↔index, excludes, custom gitdir) | yes (`gix::status`, `Repository::status()` iterator; respects `core.excludesFile`/`info/exclude`; separate `git_dir`+worktree via `gix::open_opts` / `ThreadSafeRepository::open_with_environment_overrides`) | yes, mature | yes, fastest + fsmonitor |
| add/remove → index write | plumbing only: hash blob (`repo.write_blob`), edit `gix_index::State`, `write`. No `add` porcelain — ~150 LOC | `Index::add_all/update_all` | yes |
| commit | `repo.commit(...)` / `write_object(Tree)` from index (`index.write_tree` via `gix::index` → tree editor) | yes | yes |
| log / per-path log | `rev_walk`; per-path = compare tree entry oid per commit (~50 LOC) | `Revwalk` + pathspec diff | yes |
| read blob at ref | `rev_parse_single("<ref>:<path>")` | yes | yes |
| revert | hand-rolled (same logic as today; ~200 LOC) or `gix-merge` 3-way (newer, use with care) | `repo.revert` with real 3-way merge (better than today's whole-file conflict rule) | yes |
| checkout paths | write blob bytes to worktree + update index entry (manual) | `checkout_tree` with paths | yes |
| Locking | uses `index.lock`/ref locks like git (gix-lock) — **fixes today's no-lock gap** | same | same |
| Native deps | pure Rust (pick `max-performance-safe` or `zlib-rs`) | C (libgit2; disable `https`/`ssh` features) | requires git installed |
| wasm32-unknown-unknown | plumbing crates (gix-hash/object/pack/index/diff) compile; `gix` repo API needs `std::fs` → no | no | no |

**Recommendation: gix, behind a `HistoryRepo` trait.** Reasons: pure Rust (no C toolchain on Windows/Linux CI,
smaller attack surface), honors git's lock files, fast parallel status. Shelling out is ruled out for the
history repo: Notefig users are not necessarily developers, and on macOS `/usr/bin/git` is a stub that pops
the Xcode CLT install dialog. Keep git2 as a fallback crate-feature only if gix's index writing bites (it is the
least-trodden gix path; Zed and cargo use gix mostly read-side).

Trait sketch (one per workspace, `Send + Sync`, all calls run on `cx.background_executor()`):
```rust
trait HistoryRepo {
    fn ensure_init(&self) -> Result<()>;                  // init + both exclude files
    fn status(&self) -> Result<RepoStatus>;               // branch, file flags
    fn log(&self, depth: Option<usize>, path: Option<&RelPath>) -> Result<Vec<Checkpoint>>;
    fn checkpoint(&self, msg: &str, author: Sig) -> Result<Option<Oid>>; // addAllAndCommit
    fn revert(&self, oid: Oid, author: Sig) -> Result<Option<Oid>>;      // WIP-commit + revert
    fn abort_revert(&self) -> Result<()>;
    fn read_text(&self, rev: &str, path: &RelPath) -> Result<String>;
}
enum GitErrorCode { RepoNotFound, MergeRequired, LockUnavailable, Corrupt, InvalidInput, Unsupported }
```
Map gix lock contention to `LockUnavailable` (finally reachable → the panel's Retry path gets real use).

### 6.2 Web (wasm)
GPUI's web target is itself unproven (other spikes); git should not be the blocker. Options, in order:
1. **Keep isomorphic-git on web** in a JS Web Worker, called from Rust via `wasm-bindgen` behind the same
   `HistoryRepo` trait (async variant). Reuses `git/src/git/*` verbatim incl. the storage host over
   OPFS/IndexedDB. Lowest risk; ~1 pw of bridge work once a wasm shell exists.
2. Rust-in-wasm over a VFS: gix plumbing crates (`gix-object`, `gix-pack`, `gix-index`, `gix-diff`) + own
   status/commit glue over an OPFS `Storage` trait (sync OPFS access handles in a worker). Unified code, but
   you rewrite what `gix` porcelain gives natively: ~4–6 pw.
3. Degrade on web: no history panel. Acceptable for an MVP if the web build is a demo.
Format compatibility matters for FS-Access-API workspaces (real dirs shared with the desktop app), so any web
path must keep writing real git objects.

### 6.3 GPUI shape
- `Entity<WorkspaceHistory>` per open workspace (owns the `Arc<dyn HistoryRepo>`; dropped on workspace close —
  replaces `history.dispose`/`gitWorker.dispose`), and `Entity<GitState>` holding the three row kinds as plain
  structs (`RepoSummary`, `BTreeMap<PathBuf, FileFlags>`, `Vec<Checkpoint>`) + `fetching: bool` + `generation`.
- Refresh = single-flight task: one in-flight `Task`, a `dirty` flag re-runs once on completion (replaces
  TanStack invalidate/staleTime). A write bumps `generation`; results from an older generation are dropped
  (replaces `cancelQueries` race guard in `saveCheckpoint`).
- `git:stale` → a GPUI event on the files entity (`cx.subscribe`), debounced 500 ms with `cx.background_executor().timer`;
  checkpoint/revert paths mark dirty directly. Keep the native watcher filter for `.notefig/.git`.
- Turn-completed checkpoint: subscribe to the agents entity's turn-completed event; errors logged, never fatal.
- Panel: gpui-component `Button`/`ButtonGroup`/`Popover`/`Input`(multiline)/`Switch`/`Tooltip`/`Badge` and a
  `uniform_list` for rows (cheap even if depth is raised to hundreds — the depth-25 cap was a JS-cost artifact).
  Anti-flicker freeze = render previous `PanelState` while `fetching`.
- Diff hunks: `imara-diff` (what gix uses) or `similar` for unified/side-by-side hunks; highlighting from the
  editor spike's tree-sitter stack. Zed's `buffer_diff` + `editor` diff rendering is too entangled with its
  `MultiBuffer`/`Editor` to lift directly; borrow the layout ideas only.

### 6.4 Zed as reference
Zed (`crates/git`, `crates/git_ui`, `crates/project/src/git_store.rs`, `crates/buffer_diff`): `GitRepository`
trait with a real impl that mixes git2 for object reads and the `git` binary for status/commit/remote ops, plus a
`FakeGitRepository` for tests; a `GitStore` entity per project with scan jobs on a background queue and
coalesced status refreshes; `git_panel.rs` (staging list, commit editor), `project_diff.rs` (multibuffer diff),
branch picker, blame. Useful to copy: trait + fake repo for tests (mirrors AGENTS.md "factories over fakes"),
background job queue with coalescing, `uniform_list` panel. Not useful: CLI dependency, staging UI, remotes/askpass —
Notefig needs none of it.

### 6.5 Risks
- **gix index write path** maturity (add/remove/commit-from-index, racy-git timestamp handling). Mitigate: port
  the existing interop + concurrency tests (`realGit.*.integration.test.ts`) to Rust against system git in CI on
  all three OSes before shipping.
- **Existing users' repos**: must open history repos written by isomorphic-git (loose objects, its index v2).
  gix reads these fine; add a fixture test from a real `.notefig/.git`.
- Behaviour drift: revert conflict rule (whole-file) and "Restore = revert one commit" semantics — decide
  keep-vs-fix explicitly; a gix-merge/git2 3-way revert changes outcomes.
- Windows: path normalization (`git-storage-host.ts` `native()`), CRLF/autocrlf (today none applied), long paths.
- Large workspaces: status hashing of untracked binaries in a notes folder; gix is parallel but untracked
  enumeration still walks everything — keep `.gitignore` + history exclude semantics identical.
- Concurrency with agents' own `git` CLI in the user's repo: separate gitdirs, low risk; but now real locks mean
  the app's own concurrent checkpoints must serialize per repo (a per-repo mutex in `WorkspaceHistory`).
- Web: depends on GPUI wasm existing; option 1 keeps git off the critical path.

### 6.6 MVP subset and effort (person-weeks, one Rust dev familiar with GPUI)

| Item | pw |
|---|---|
| `HistoryRepo` trait + gix impl: init/excludes, status (incl. custom gitdir excludes), log(+path), checkpoint (add/remove/commit), read_text | 2.0 |
| revert + abort-revert (port today's blob-level algorithm as-is) | 0.75 |
| Test port: interop/concurrency/dual-repo isolation vs system git, fixture of an isomorphic-git-written repo, fake repo for UI tests | 1.0 |
| `WorkspaceHistory`/`GitState` entities, single-flight refresh, `git:stale` debounce, turn-completed checkpoint, lifetime on workspace close | 0.75 |
| Checkpoint panel in GPUI (all 4 states, popover, revert banner, copy hash, i18n hookup) | 1.0 |
| Agent tools `history_log/checkpoint/restore` wired to the trait | 0.25 |
| **MVP total (native mac, Win/Linux compile-clean)** | **~5.75** |
| Windows/Linux hardening (paths, CRLF, CI matrix) | +1.0 |
| Diff card renderer (hunks + side-by-side/unified + collapse) — if not owned by editor spike | +1.5–2.5 |
| Web via isomorphic-git bridge (after a GPUI wasm shell exists) | +1.0–1.5 |
| Nice-to-have unlocked by native speed: per-checkpoint diff view, deeper history, file-scoped history | +1.5 |

Out of MVP (dead today): branches, push/pull/fetch/auth, staging UI, ahead/behind, auto-save switch.
