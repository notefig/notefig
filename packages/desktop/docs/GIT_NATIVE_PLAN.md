# Native Git Integration Plan (Core + Adapter-Friendly)

## Goals

- Provide embedded Git support for core workflows without requiring system Git as a runtime dependency.
- Keep platform adapter complexity bounded and avoid adding Git-specific APIs per platform.
- Ensure interoperability with external/system Git on the same workspace for basic operations.

## Non-Goals (v1)

- Full Git feature parity (rebase, cherry-pick, stash, worktrees, submodules, LFS, hook execution).
- Perfect compatibility for every Git edge case in v1.

## Compatibility Target (v1)

Basic operations must be interoperable with system Git when operating on the same repository:

- `status`
- `add` / `unstage`
- `commit`
- `branch` (list/create/switch)
- `checkout` (branch + file restore)
- `log`
- `fetch` / `pull` (fast-forward only)
- `push`
- `.gitignore` handling (common cases)

## High-Level Architecture

Git is a core module (shared app logic). File-system adapters remain generic and do not gain Git-specific verbs.

```text
UI / Commands
    |
    v
Git Service (app layer orchestration)
    |
    v
Git Core Module (shared logic)
    |                   \
    |                    \-- Remote Transport (HTTP/Auth)
    v
Git Storage Host (small generic contract)
    |
    v
Platform FS Adapter (existing adapter abstraction)
    |
    v
Workspace on disk / browser-backed directory (includes .git)
```

## Kernel Choice (v1)

- Use `isomorphic-git` as the initial Git kernel.
- Rationale:
  - Runs in browser and JS runtime without requiring system Git.
  - Supports v1 compatibility target operations.
  - Allows one shared implementation path while keeping Tauri.
- Design constraint:
  - Keep `GitService` as the stable boundary so kernel can be swapped later if needed.

### Why this placement

- Git logic is shared once.
- Platform-specific work is limited to generic storage semantics.
- Future adapters (e.g., API-backed) implement the same small host contract.

## isomorphic-git FS Adapter Strategy

`isomorphic-git` supports custom `fs` objects. We will not expose `isomorphic-git` directly to platform adapters.

Instead:

- Build an `isomorphicGitFs` shim inside the Git core module.
- `isomorphicGitFs` maps `isomorphic-git` filesystem calls to `GitStorageHost` primitives.
- Keep platform adapters generic and unchanged except where a missing primitive must be added for all platforms.

Expected `isomorphic-git` fs surface for our target operations (exact usage depends on command path):

- `readFile`
- `writeFile`
- `readdir`
- `mkdir`
- `rmdir`
- `unlink`
- `stat`
- `lstat`
- `rename`
- `readlink` / `symlink` (may be required by some repos/platforms)
- `chmod` (best-effort depending on platform)

Implementation note:

- The shim should provide promise-based methods and normalize path + stat semantics for cross-platform consistency.
- Any unsupported filesystem behavior must be surfaced as capability limitations, not hidden failures.

## Basic Interface Proposal

This is intentionally small and capability-oriented.

```ts
// App-facing API
export interface GitService {
  getCapabilities(repoPath: string): Promise<GitCapabilities>;

  status(input: { repoPath: string }): Promise<RepoStatus>;
  add(input: { repoPath: string; paths: string[] }): Promise<void>;
  unstage(input: { repoPath: string; paths: string[] }): Promise<void>;
  commit(input: {
    repoPath: string;
    message: string;
    author?: { name: string; email: string };
  }): Promise<{ commitOid: string }>;

  listBranches(input: { repoPath: string }): Promise<BranchInfo[]>;
  createBranch(input: {
    repoPath: string;
    name: string;
    from?: string;
  }): Promise<void>;
  switchBranch(input: { repoPath: string; name: string }): Promise<void>;
  checkoutPaths(input: {
    repoPath: string;
    paths: string[];
    from?: string;
  }): Promise<void>;

  log(input: {
    repoPath: string;
    limit?: number;
    ref?: string;
  }): Promise<CommitInfo[]>;

  fetch(input: {
    repoPath: string;
    remote?: string;
    branch?: string;
  }): Promise<void>;
  pull(input: {
    repoPath: string;
    remote?: string;
    branch?: string;
  }): Promise<PullResult>;
  push(input: {
    repoPath: string;
    remote?: string;
    branch?: string;
  }): Promise<void>;
}

export interface GitCapabilities {
  fastForwardPull: boolean;
  fileCheckout: boolean;
  remoteHttp: boolean;
  ssh: boolean;
  lfs: boolean;
  submodules: boolean;
}

// Minimal host interface used by Git Core
export interface GitStorageHost {
  readFile(path: string): Promise<Uint8Array>;
  writeFileAtomic(path: string, data: Uint8Array): Promise<void>;
  renameAtomic(from: string, to: string): Promise<void>;
  deleteFile(path: string): Promise<void>;
  stat(path: string): Promise<{
    exists: boolean;
    isFile: boolean;
    isDir: boolean;
    mtimeMs?: number;
  }>;
  readDir(
    path: string,
  ): Promise<Array<{ name: string; isFile: boolean; isDir: boolean }>>;
  createDir(path: string): Promise<void>;
  removeDir(path: string): Promise<void>;
  lstat(path: string): Promise<{
    exists: boolean;
    isFile: boolean;
    isDir: boolean;
    isSymbolicLink: boolean;
    mode?: number;
    mtimeMs?: number;
  }>;
  readLink(path: string): Promise<string>;
  createSymlink(target: string, path: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;

  // Lock names are logical, implementation can use lock files or mutexes
  lock(name: string): Promise<void>;
  unlock(name: string): Promise<void>;
}
```

Notes:

- Git state should live with the workspace (`.git`) for interoperability.
- Host methods are generic file primitives, not Git-specific platform adapter APIs.
- `GitStorageHost` is intentionally aligned with `isomorphic-git` fs expectations through a shim, not by expanding platform adapters with Git verbs.

## Phased Implementation Plan

### Phase 0: RFC + Scope Lock

- Write an internal RFC that locks v1 operation scope and explicit non-goals.
- Lock kernel decision to `isomorphic-git` for v1 and define swap criteria for v2+.
- Define capability flags and UX behavior for unsupported operations.

Deliverable: approved architecture + scope document.

### Phase 1: Contracts + Skeleton

- Add `GitService` interfaces in shared package.
- Add `GitStorageHost` contract in shared package.
- Create desktop and web host adapters that map contract -> existing platform adapter/file APIs.
- Implement `isomorphicGitFs` shim and map required fs methods.
- Implement no-op or stub core to validate wiring and error propagation.

Deliverable: end-to-end plumbing with mocked Git responses.

### Phase 2: Local Core Workflows

- Implement local operations:
  - `status`, `add`, `unstage`, `commit`, `branch`, `switch`, `checkoutPaths`, `log`
- Persist repository state in workspace `.git` layout.
- Handle index and refs updates with lock/atomic semantics.
- Verify shim behavior for path normalization, stat/lstat parity, and symlink/file mode handling.

Deliverable: basic local workflows working without remotes.

### Phase 3: Remotes (HTTP) + Auth

- Implement `fetch`, `pull` (fast-forward only), `push`.
- Add transport/auth callback interfaces for credentials.
- Add user-facing error mapping (auth failures, non-ff, conflict needed).

Deliverable: clone/fetch/pull/push for standard HTTPS remotes.

### Phase 4: Hardening + Compatibility

- Add cross-check tests against system Git in CI/local harness.
- Validate concurrent access behavior with external Git process.
- Performance checks on large repos (status/log responsiveness).
- Document known limitations for v1.
- Track per-platform compatibility scorecards for the fs shim.

Deliverable: compatibility baseline with confidence metrics.

## Test Scenarios (Compatibility Matrix)

Each scenario should be validated in two directions:

1. App operation -> verify with system `git`
2. System `git` operation -> verify with app

Core scenarios:

1. `status` on clean repo
2. `status` with unstaged file edits
3. `add` single file + verify staged set
4. `unstage` single file + verify index rollback
5. `commit` creates valid commit; verify `HEAD`, tree, author/message
6. branch create/switch roundtrip
7. checkout file from `HEAD` restores content
8. `.gitignore` excludes ignored files from status
9. `log` order and commit IDs match system Git
10. fetch remote updates tracking refs
11. pull fast-forward succeeds and updates working tree
12. pull non-fast-forward returns explicit unsupported/conflict-needed result
13. push updates remote refs
14. lock contention: app and system Git operations do not corrupt refs/index
15. interruption safety: crash during write does not leave corrupted refs/index
16. symlink repo fixture handling (skip/fail by capability on unsupported platforms)
17. file mode changes (executable bit) behave consistently with declared platform capability
18. rename-heavy changes preserve index/worktree consistency

Recommended assertions:

- `git status --porcelain` equality (or normalized equivalent)
- `git rev-parse` results match expected refs
- `git fsck` passes after scenario suites
- object existence and tree structure checks for produced commits
- parity checks between app-reported status and system git status on same commit

## Capability Flags (Extended)

In addition to operation-level capabilities, include storage-related capability flags:

- `supportsSymlinks`
- `supportsFileMode`
- `supportsAtomicRename`
- `supportsAdvisoryLocks`

These flags inform behavior and testing expectations rather than silently degrading correctness.

## Error Model (High Level)

Define stable typed errors so UI can render clear actions:

- `AuthRequired`
- `AuthFailed`
- `NotFastForward`
- `MergeRequired`
- `LockUnavailable`
- `RepoNotFound`
- `UnsupportedOperation`
- `CorruptRepository`

## Risks and Mitigations

- Locking/atomicity differences across platforms
  - Mitigation: strict host contract + stress tests + crash/recovery tests.
- Hidden Git edge cases in index/refs handling
  - Mitigation: narrow scope + conformance tests against system Git.
- Browser sandbox constraints
  - Mitigation: explicit repository-open/reopen UX and clear capability flags.

## Suggested Initial Milestone (2-3 sprints)

- Ship local workflows (`status/add/unstage/commit/branch/switch/log`) with compatibility tests.
- Keep remotes behind feature flag until HTTP/auth flows are stable.
- Publish limitations page and capability reporting in UI.
