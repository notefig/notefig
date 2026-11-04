# notefig-history

Notefig's document history (spec: `spec/03-git.md`): a hidden, app-owned git
repo per workspace, gitdir `<ws>/.notefig/.git`, worktree = the workspace.
It never reads, stages or commits to the user's `<ws>/.git`; the one thing it
writes there is the line `.notefig/` in `<ws>/.git/info/exclude`. No gpui.

Backend: **gix 0.90** with `default-features = false, features = ["index",
"revision", "sha1"]` (pure Rust, zlib-rs), plus the `ignore` crate (already
in the shared target via `notefig-workspace`) for the worktree walk. git2 was
not needed: gix's index encoding (`gix::index::File::write`, with a real
`index.lock`) worked for everything.

## API

```rust
pub trait HistoryRepo: Send + Sync {          // blocking: run on a background executor
    fn workspace_path(&self) -> &Path;
    fn is_initialized(&self) -> bool;         // gitdir has HEAD + config (panel's `initialized`)
    fn ensure_init(&self) -> Result<()>;      // history.ready(): create/repair, both excludes
    fn status(&self) -> Result<RepoStatus>;   // RepoNotFound when not initialized
    fn log(&self, depth: Option<usize>, path: Option<&str>) -> Result<Vec<Checkpoint>>;
    fn checkpoint(&self, message: &str, author: &Signature) -> Result<Option<String>>; // addAllAndCommit
    fn revert_commit(&self, oid: &str, message: Option<&str>, author: &Signature) -> Result<Option<String>>;
    fn abort_revert(&self) -> Result<()>;
    fn read_text(&self, rev: &str, path: &str) -> Result<String>;
    // provided:
    fn revert_to(&self, oid: &str, author: &Signature) -> Result<Option<String>>; // WIP commit + revert (panel "Restore")
    fn file_versions(&self, path: &str, from: &str, to: &str) -> Result<FileVersions>; // history_diff
}
```

- `GixHistoryRepo::new(ws)` — the real repo (`with_git_dir(ws, gitdir)` for
  any gitdir; tests use `<ws>/.git`). Its writers serialize on an internal
  mutex; other processes are kept out by git lock files.
- `FakeHistoryRepo::{new, initialized}(ws)` — in-memory worktree + linear
  snapshot commits, `write_file/remove_file/file`, `fail_next(err)` for
  error states. For app/panel tests.
- Types: `RepoStatus { current_branch, staged, unstaged, untracked,
  conflicts }` (+ `has_changes()`), `FileChange { path, kind: Added|Modified|Deleted }`,
  `Checkpoint { oid, message, author_name, author_email, author_time, committer_time }`
  (+ `hash()` 7 chars, `summary()` first line or "Commit" — the panel row),
  `Signature::{new, panel(), harness(id), agent_tool()}`,
  `HistoryError { code, message }` with `HistoryErrorCode::{RepoNotFound,
  MergeRequired, LockUnavailable, CorruptRepository, InvalidInput, Io}`.
- Helpers: `history_git_dir`, `ensure_exclude_lines(git_dir, lines)`,
  `checkpoint_message(prompt)` (72 chars, `…`), `HISTORY_EXCLUDE_LINES`.
- `tools` — the agent tools, shaped for `notefig_agent::services::AppToolCall`
  (that crate already validates input, contains paths and renders MCP
  results; these return the TS `execute` value/error text):
  - `history_log(repo, relative: Option<&str>) -> Result<Value, String>` →
    `[{oid, message (trimmed), author (name), timestamp (author ms)}]`;
    `history_log_entries` returns the typed `HistoryLogEntry`s.
  - `history_diff(repo, relative, from, to)` → `{from, to, fromContent, toContent}`.
  - `history_checkpoint(repo, message)` → `{oid}` (`null` when nothing
    changed), author `agent <agent@notefig.local>`.
  - `history_restore(repo, relative, absolute, checkpoint, write)` → `null`;
    `write` is the app's adopting write (`documents.write`).
    `history_restore_content` is the read half alone.
  - `turn_checkpoint(repo, prompt, harness_id)` — the after-every-turn
    checkpoint (`<harnessId> <agent@notefig.local>`, prompt cut to 72).
  Every tool calls `ensure_init` first, like TS `history.ready()`. After a
  checkpoint the app must mark its git rows stale itself (`git:stale`).

## Verified (`cargo test -p notefig-history`: 55 tests, all against system git where relevant)

- `tests/real_git_interop.rs` (22) — port of `realGit.interop`: init readable
  by git (`main`), checkpoint visible to git and `fsck --full` clean,
  add/modify/delete in one checkpoint (`M/D/A`), revert (+ revert of an
  added file deletes it), whole-file conflict → `MergeRequired`, no-op
  re-revert, root revert invalid, `revert_to` WIP sequence, abort-revert,
  read_text by oid/short oid/`HEAD`, path-scoped log == `git log -- path`,
  system-git commits/branches/edits/staging reflected in log/status,
  `.gitignore` parity, status/log parity, detached gitdir over a user repo
  (user status untouched, history readable by git), worktree `.gitignore`
  honoured.
- `tests/dual_repo_isolation.rs` (15) — port of `dualRepoIsolation`: the
  user's `.git` byte-identical across init/status/checkpoint/revert/abort,
  history HEAD (not the user's) answers reads, own `info/exclude` honoured,
  scratchpads are the one versioned app-dir subtree, `.git` dirs never
  versioned even with an empty exclude, `RepoNotFound` before init even
  next to a user repo.
- `tests/real_git_concurrency.rs` (4) — port of `realGit.concurrency`:
  racing app + git commits never corrupt (`fsck --full`), interleaved
  commits lose no history, a stale `index.lock` now **blocks** the app with
  `LockUnavailable` (TS ignored it; test inverted), in-process concurrent
  checkpoints serialize.
- `tests/isomorphic_git_fixture.rs` (1) — a copy of a real
  isomorphic-git-written `~/Documents/*/.notefig/.git` (or
  `NOTEFIG_HISTORY_FIXTURE=<gitdir>`; sources are only read): log/authors/
  times == `git log`, file contents == `git show`, path log parity, its
  index decodes (status == `git status`), then abort-revert, checkpoint and
  revert on top with `fsck --full` clean. Ran against
  `bnw-sr&ed-2026/.notefig/.git`.
- `tests/tools.rs` (13) — port of `history-tools.test.ts` over the fake, the
  fake's contract, and a real-repo checkpoint → log → diff → restore round trip.

## Deviations from the TS service (deliberate)

- Reverting a commit that **added** a file deletes it from the worktree (TS
  only dropped it from the index, so the next checkpoint re-added it).
- `checkpoint` stages every dirty path, including ones already staged with
  further worktree edits (TS skipped those, committing the staged version).
- Locks are real: `index.lock`/ref locks are honoured → `LockUnavailable`.
- `read_text` accepts any rev (short oid, `HEAD`, branch), not only full oids.
- Commit messages get a trailing `\n` (like git); log consumers trim.
- New index entries record the executable bit (`100755`) like git; TS always
  wrote `100644`. Symlinks are skipped by the walk (TS threw).
- `log(path)` = commits whose blob at `path` differs from the first
  parent's (git's `log -- path` on linear history), not isomorphic-git's
  follow/stop heuristics. `depth` applies after filtering.
- `index` is rewritten without extensions (the TREE cache would be stale).

## Gaps

- No hunk/unified diff: `history_diff` returns both contents, like TS. A
  checkpoint diff view would add `imara-diff`/`similar` here.
- `history_restore`'s result: the TS tool's `undefined` became an MCP text
  part without `text`; the agent crate renders `null` as the text `"null"`.
  Through the agent seam `Value`s are re-serialized with sorted keys
  (`serde_json` without `preserve_order`); use the typed structs
  (`HistoryLogEntry`, `HistoryDiffResult`) where exact TS key order matters.
- Ignore semantics: the gitdir's `info/exclude` is applied as a filter on
  top of the walk's `.gitignore`s, so a `.gitignore` negation cannot
  re-include a path the exclude ignores (git would let it). Nested repos
  (a subdir with its own `.git`) are walked into, minus their `.git`.
  No global excludes / `core.excludesFile` (TS had none either).
- Status hashes every tracked file whose size/mtime differ from the index
  or that is racy; no parallelism, no fsmonitor. Fine for notes-sized
  workspaces; not benchmarked on large ones.
- No CRLF/autocrlf, no filters/attributes, no sparse/split index, no
  merge commits handling beyond first parent in path logs. Windows paths are
  untested (code converts `/` ↔ native via path components).
- Not wired: the app owns the per-workspace entity, refresh/single-flight,
  `git:stale` debounce, turn-completed hook, and the panel.
