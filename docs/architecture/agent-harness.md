# Agent Harness Architecture

Metrists becomes a **markdown-document-first AI harness**: markdown documents
are live artifacts that agents follow and execute. Users mostly write prompts;
agents create and modify the documents — by editing markdown text directly and
by inserting **deferred blobs**, custom fenced blocks that render as
interactive widgets (questions, approvals, status) for contextual AI↔user
interaction.

Agent processes (Claude Code, opencode, pi, …) run on the user's machine:

- **Desktop (Tauri)** — spawned locally as child processes.
- **Web** — reached through a tiny self-hostable **relay server** plus a
  **CLI worker** (`notefig agent`) running on the user's machine.

Everything is open source. The relay is a spec, not a service: the app can
point at any relay URL that implements `packages/relay/PROTOCOL.md`.

## Core decisions

1. **ACP (Agent Client Protocol)** is the harness contract. Metrists is an ACP
   *client*; harnesses connect through their existing ACP adapters
   (`@zed-industries/claude-code-acp`, `gemini --experimental-acp`, …). A
   future Metrists-owned harness is just another ACP agent — no fork decision
   needed now.
2. **Deferred blobs** are fenced code blocks with a `notefig:<type>` language
   tag and a YAML payload. They degrade to plain code blocks in any other
   markdown renderer and round-trip byte-identically through our codec.
3. **The relay is a dumb encrypted pipe.** It forwards opaque frames between
   exactly two peers, understands nothing above its envelope, requires no
   accounts, and deploys as a single small process/container.
4. **Agent file edits flow through the existing sync machinery** (watcher
   events → `DocumentSync` last-writer-wins). No new merge system.
5. **Tasks are the unit of parallel work.** A workspace can run N agent
   tasks concurrently, each backed by its own adapter process and ACP
   session. Everything downstream (collections, permissions, blobs, tunnel
   frames) is keyed by `taskId`.

## Who speaks what

The layering that trips people up, made explicit:

| Component | Speaks | Never does |
| --- | --- | --- |
| App TypeScript (webview, both platforms) | **ACP client**: initialize, sessions, prompts, permission responses; receives all `session/update` | Touch a process handle directly |
| `src-tauri/agent_proc.rs` (desktop) | Nothing. Spawns processes, pumps stdio lines as events, kills | Parse a single JSON-RPC message |
| CLI worker `notefig agent` (web) | Nothing above the tunnel. Pairing, per-task process supervision, encrypted byte pump, file-watch events | Parse ACP; answer any protocol method |
| Harness adapter (claude-code-acp, …) | **ACP agent** side | — |

There is exactly one ACP client in the system — the app — on both
platforms. The Rust host and the CLI worker are byte movers. Every ACP
message the harness sends reaches the app verbatim (desktop: stdout-lines
events; web: encrypted frames), and every response travels back the same
way. What *differs* per platform is not who speaks, but which capabilities
the app advertises (next section).

## Capability strategy

ACP file-system methods (`fs/read_text_file`, `fs/write_text_file`) are
*optional client capabilities* declared at `initialize`. We use that
negotiation deliberately:

- **Desktop advertises `fs: { readTextFile: true, writeTextFile: true }`.**
  Agent reads can serve unsaved editor content; agent writes flow through
  `AgentWriteGate` (per-file serialization + task attribution) and sync into
  open editors immediately.
- **Web advertises `fs: false`.** The harness uses its own native file
  tools — it runs on the machine that has the files. No `fs/*` traffic
  exists, so the CLI worker needs no protocol awareness at all; the app
  adopts changes through the worker's watch channel, the same adoption path
  as any external edit.
- **Terminal capability is `false` everywhere** until Phase 4.

The asymmetry is deliberate: it is what keeps the worker thin, and ACP's
capability negotiation exists precisely so clients in different positions
can make this choice.

## Layer map

```
UI (AgentPanel + task list, PermissionCard, Blob widgets)
  ↕ TanStack DB collections / useLiveQuery (all rows keyed by taskId)
TaskManager                     per-workspace registry of AgentTasks
  └─ AgentTask (× N parallel)   one transport + ACP session + permission
  ↕ typed events                queue + turn state per task
ACP client layer                ClientSideConnection (official lib) +
  ↕ AgentTransport              NotefigAcpClient (capabilities per locus)
  │
  ├─ TauriStdioTransport        desktop: invoke → src-tauri agent_proc.rs
  ├─ RelayTransport             web: WebSocket + E2E-encrypted frames
  └─ LoopbackTransport          tests: in-memory pair
                                     │
                              packages/relay (dumb pipe: rooms, TTL, limits)
                                     │
                              CLI worker `notefig agent` (thin)
                              pairing + one spawned adapter process per task
                              + encrypted byte pump + chokidar watch channel
```

The guiding symmetry: **the ACP session layer never knows where the agent
process lives.** Desktop is a local stdio pipe; web is the same
newline-delimited JSON-RPC byte stream tunneled browser ↔ relay ↔ worker ↔
harness stdin/stdout. This mirrors how `worker-rpc.ts` gives one typed promise
API over any message port.

## Boundary contracts

### AgentTransport ↔ ACP client

`packages/desktop/src/agent/agent-transport.interface.ts`

```ts
interface AgentTransport {
  readonly locus: "local" | "remote";
  send(line: string): void;            // one JSON-RPC message, no trailing \n
  onLine(cb: (line: string) => void): () => void;
  onClose(cb: (error?: AgentTransportError) => void): () => void;
  close(): Promise<void>;
}
```

Errors are a single `AgentTransportError` class discriminated by type
(`spawn_failed | closed | relay_unreachable | pairing_failed | …`), mirroring
`FsError`. The official ACP TS library's `ClientSideConnection` takes a
Writable/Readable stream pair, so the transport exposes exactly that adapter —
it is transport-shape, not process-shape, by design.

### ACP client ↔ IPlatformAdapter

The client-side methods ACP requires us to implement map onto the existing
platform seam:

| ACP client method | Metrists implementation |
| --- | --- |
| `fs/read_text_file` | *Desktop only* (web advertises `fs: false`): `platformAdapter.readFiles([path])` + line/limit slicing in TS; `BatchResult` failures become JSON-RPC errors carrying the `FsError` message |
| `fs/write_text_file` | *Desktop only*: **AgentWriteGate** (per-file serialization, task attribution) → `platformAdapter.writeFiles` → standard content-change event so `DocumentSync` arbitrates against open editors |
| `session/request_permission` | **PermissionBroker** (promise-per-request queue, one per task) → UI card rendering the agent-provided options verbatim; remember-choice stored per workspace+tool-kind in KV |
| `terminal/*` | Phase 4, desktop only (new Rust pty commands; capability advertised only then) |
| `session/update` (notification) | The owning AgentTask writes into TanStack collections (below) |

Client capabilities at `initialize` come from the transport locus — see
**Capability strategy** above.

### ACP client ↔ TaskManager / AgentTask

`TaskManager` is a per-workspace singleton registry (same convention as
`git-service-store.ts`); each **AgentTask** it manages owns one transport +
one ACP connection + one session + its own PermissionBroker and turn state.

TaskManager owns:

- **Harness config** — which ACP adapter command to spawn, from
  `HarnessDefinition` (shared Zod schema); built-ins plus user-configured
  commands. A workspace-trust confirmation is required before the first spawn
  in a workspace; commands are **never** taken from document content.
- **Task lifecycle** — `createTask` spawns a fresh adapter process (see
  Tasks and parallelism), `cancelTask` sends `session/cancel` + kills,
  `disposeAll` on workspace close.

Each AgentTask owns:

- **Session lifecycle** — `initialize` → `authenticate` (if the adapter
  reports login needed, surface "finish login in your terminal") →
  `session/new` with `cwd = workspacePath` → prompt loop. `sessionId`
  persisted in KV per task; `session/load` attempted on reopen when the
  agent advertises `loadSession` (Phase 4).
- **Cancellation** — `session/cancel` notification, then process kill on
  teardown. Cancel resolves all of this task's pending permission requests
  as `cancelled` (per spec); other tasks are untouched.
- **Blob pickup** — when this task's turn is idle and blobs it authored have
  been answered, it auto-composes a continuation prompt (see Blobs).

### AgentTask ↔ UI state

New local-only TanStack DB collections (`agent-collections.ts`), consumed via
`useLiveQuery` like everything else — every row carries `taskId`:

- `agentTasks` — `{ taskId, parentTaskId?, workspacePath, title, status,
  harnessId, createdAt }`
- `agentTurns` — `{ turnId, taskId, sessionId, status, stopReason? }` — one
  per `session/prompt` round-trip
- `agentMessages` — `{ messageId, taskId, turnId, role: "user" |
  "assistant", createdAt }` — the **addressable transcript unit** (deep
  links, revert, persistence all key on it; see Identity below)
- `agentEvents` — `{ id, messageId, turnId, taskId, kind: "message_chunk" |
  "tool_call" | "tool_call_update" | "plan" | "usage", payload }`; message
  chunks are coalesced per assistant message (reuse
  `src/lib/markdown-joiner-transform.ts` to re-chunk streamed markdown at
  safe render boundaries)
- `agentPermissionRequests` — `{ id, taskId, sessionId, title, options,
  status }`

Tool calls of kind `edit` with diff content render as inline diff cards.

### Browser ↔ relay ↔ CLI worker (web mode)

The worker is deliberately **thin** — it never parses ACP. It does four
things: pairing, spawning one adapter process per task, pumping encrypted
bytes between those processes and the tunnel, and publishing file-change
events from a chokidar watcher. Because web mode advertises `fs: false`
(see Capability strategy), there are no client-side file methods to serve —
the harness writes files natively and the browser adopts the changes through
the watch channel, the same way desktop adopts external edits.

Inside the encrypted payload, frames are multiplexed by channel and task:
`{ ch: "acp" | "watch" | "ctl", taskId?, body }` —

- `acp`: one JSON-RPC line for the task's adapter process (both directions)
- `watch`: file-change events from the worker's watcher (no taskId)
- `ctl`: worker control — `start-task` (harness id + cwd → spawns a
  process), `stop-task`, `list-tasks`, and `task-exit` events

v1 scope note: in web mode the worker *owns* the folder
(`notefig agent --dir ./book`); the browser does not also mount it through
File System Access. This avoids split-brain between two local sources of
truth.

## ACP mapping summary

Verified against agentclientprotocol.com (protocol/{overview, session-setup,
prompt-turn, file-system}) and the `@zed-industries/agent-client-protocol` TS
library. JSON-RPC 2.0, newline-delimited, bidirectional.

**We call (agent-side):** `initialize` (version + capability negotiation),
`authenticate`, `session/new` (`{cwd, mcpServers}` → `{sessionId}`),
`session/load` (replays history via `session/update`), `session/prompt`
(`ContentBlock[]` → `{stopReason: end_turn | max_tokens | max_turn_requests |
refusal | cancelled}`), notification `session/cancel`.

**We implement (client-side):** `session/request_permission`,
`fs/read_text_file`, `fs/write_text_file`, optional `terminal/*`, and receive
`session/update` notifications discriminated by `sessionUpdate`
(`agent_message_chunk`, `tool_call`, `tool_call_update`, `plan`,
`usage_update`, mode changes).

Paths are absolute, lines 1-based; extensions ride in `_meta` /
`_`-prefixed methods. All protocol types we depend on are pinned and
re-exported through `packages/shared/src/agent/acp-types.ts` — a spec bump is
one file.

`mcpServers` is `[]` in v1; later phases pass a Metrists MCP server exposing a
`notefig_await_blob` tool so agents can block on a blob answer mid-turn.

## Tasks and parallelism

A **task** is the unit of parallel agent work — "rewrite chapter 3" and
"fact-check the pricing doc" can run at the same time in one workspace.

- **Process per task.** Each task spawns its own adapter process with one
  ACP connection and one session. Adapters' support for multiple concurrent
  sessions per process is unproven, and processes give free crash isolation
  and trivially correct cancellation; the LLM work dwarfs the process
  overhead. (If adapters later prove multi-session-safe, TaskManager can
  pool connections without changing any interface — the task is the
  abstraction, not the process.)
- **Everything is task-keyed.** Collections rows, permission queues, tunnel
  frames, and blob attribution all carry `taskId`. On desktop
  `procId = taskId`; on web the worker maps `taskId → child process` via
  `ctl` messages.
- **Shared workspace, serialized writes.** All desktop-mediated agent writes
  pass through `AgentWriteGate`, which serializes per-file and records which
  task last touched each path. Two tasks editing the same file is allowed
  but *visible*: the UI surfaces overlap warnings ("two tasks are editing
  pricing.md"). In web mode (native writes) attribution comes best-effort
  from tool-call updates instead. True isolation (git worktree per task) is
  a documented later option, not v1.
- **Cancellation is per task**: `session/cancel` + process kill + that
  task's permission queue resolved as cancelled. Other tasks never notice.
- **UI**: the agent panel hosts a task list (create / switch / cancel);
  each task has its own transcript view over the shared collections.

### Identity

We adopt opencode's id scheme (`@notefig/shared/agent` `ids.ts`):
`prefix_` + 16 hex chars (64-bit big-endian: ms-timestamp × 4096 + a
per-millisecond counter) + 10 random base62 chars. The id **is** the sort
key — no separate ordering columns anywhere.

| Entity | Prefix | Direction | Why |
| --- | --- | --- | --- |
| Task | `task_` | descending (time bits inverted) | any lexicographic task list is newest-first |
| Turn | `trn_` | ascending | chronological within a task |
| Message | `msg_` | ascending | chronological; timestamp decodable from the id |
| Event | `evt_` | ascending | reconcilable stream ordering |
| Permission | `per_` | ascending | queue order |

Two rules that follow from ACP's shape:

- **Message ids are minted client-side.** ACP streams anonymous
  `session/update` chunks (only `toolCallId` exists), so the app creates a
  `msg_` id for the user message when it sends the prompt and for the
  assistant message when its first update arrives. Every event row
  references its `messageId` — the transcript is addressable even though
  the wire protocol isn't.
- **Durable vs. live events** (opencode's event-sourcing rule, adopted for
  Phase 4 persistence and relay reconnect): delta-style events
  (`message_chunk`) are live-only and never persisted or replay-buffered;
  completed boundaries (message finished, tool call completed, turn ended)
  carry full values and are the replayable record. A reconnecting or
  restarting client rebuilds state from boundaries and receives deltas only
  live.

Blob envelope ids (`q_8f2a`) are deliberately a different scheme — short
and agent-authored, since they live in user-visible markdown.

### Prompt delivery

Prompts sent while a task's turn is running are not an error; they carry a
**delivery mode** (opencode's vocabulary): `queue` (FIFO, promoted when the
turn ends — v1 behavior) or `steer` (interjected mid-turn — later, where
harness support allows). Blob-answer continuations are simply
queue-delivery synthetic prompts, which is why they need no special
machinery.

## Deferred blobs

**Ownership model: the agent authors, the app owns.** The agent's only role
is emitting a well-formed fence (taught via a system preamble in every
`session/prompt` — one shared constant). From that moment the app owns the
entire lifecycle: it detects the fence through the same content-change
pipeline that renders documents (never by polling files for state), renders
the widget, validates and patches answers itself, and composes the
continuation prompt. The document is the **durable record** of the
interaction — portable, git-diffable, readable in any renderer — not the
message bus. If prompt-guided authoring proves unreliable (persistent
malformed fences) or mid-turn blocking becomes necessary, the upgrade path
is the Phase 4 MCP server (`notefig_ask_user` et al.), where the agent
calls a tool and the app materializes the blob — same lifecycle, different
authoring channel.

### Wire format

````markdown
```notefig:question
id: q_8f2a
status: pending
prompt: Which pricing tier does this doc target?
options: [Free, Pro, Enterprise]
```
````

- Language tag `notefig:<type>`; body is YAML.
- Canonical envelope (Zod, `packages/shared/src/blobs/blob-envelope.ts`):
  `id` (`/^[a-z]+_[a-z0-9]{4,}$/`), `status`
  (`pending → answered | dismissed | superseded`), `createdBy`
  (`agent | user`), optional `answeredAt`. `.passthrough()` — unknown keys
  are preserved verbatim.
- Invalid YAML or a failed schema parse renders as an ordinary code block
  with error chrome and still round-trips byte-identically.

### Why a code block, not a new node

In ProseMirror the blob **stays a `codeBlock` node** with
`language: "notefig:question"`. The editor schema
(`editor-schema-kit.ts`) and the worker codec are untouched, so the
byte-identical round-trip guarantee holds *by construction* — a blob is a
code block with a fancy node view. `blob-node-view.tsx` decorates code blocks
whose language starts with `notefig:`, parses the YAML lazily, validates
against the registry schema, and renders the type's widget (or the raw-fence
fallback).

### Answer path and concurrency

Answers are **ID-addressed string surgery**, never whole-document
re-serialization:

1. Widget calls `answerBlob(filePath, blobId, patch)`
   (`blob-actions.ts`).
2. Read the current authoritative markdown — the editor doc if the file is
   open (`editor-store`), else disk.
3. `patchBlobInMarkdown(markdown, id, patch)` rewrites only the fenced block
   (order- and comment-preserving YAML via the `yaml` package).
4. Write through the normal save path: `DocumentSync.pushUpdate` when an
   editor is open (undo history, autosave, and hashes stay coherent), direct
   `writeFiles` otherwise.

If the blob was deleted or rewritten since parse, the patch returns
`not_found`/`conflict`; the widget re-syncs from latest text and, if the blob
is gone, shows `superseded`. Agent writes land through AgentWriteGate emitting
standard change events, so the existing last-writer-wins pipeline arbitrates
agent-vs-editor races — the same as any external edit today.

**Agent notification:** answered blobs are injected into the authoring
task's next `session/prompt` as a structured preamble ContentBlock ("The
user answered blob q_8f2a in docs/pricing.md: 'Pro'"). Blob → task
attribution is recorded when the fence is first detected (the task whose
turn wrote it), so answers route to the right task's continuation prompt.
The task triggers the continuation automatically when idle with queued
answers. The MCP `notefig_await_blob` tool is the Phase 4 upgrade for
mid-turn blocking.

### One-file blob type DX

Adding a blob type is one file (registry pattern shared with
`drag-protocol.tsx`):

```tsx
// packages/desktop/src/components/editor/blobs/question.blob.tsx
export default defineBlobType({
  type: "question",
  schema: z.object({
    prompt: z.string(),
    options: z.array(z.string()).optional(),
    answer: z.string().optional(),
  }),
  Widget({ blob, answer }) { /* React; call answer({ answer: "Pro" }) */ },
  onAnswer: (blob, patch) => ({ ...patch, status: "answered", answeredAt: now() }),
  summaryText: (blob) => blob.prompt,   // plain-text/export fallback
});
```

`blob-registry.ts` collects `import.meta.glob("./*.blob.tsx")`. Initial
types: `question`, `choice`, `approval`, `status` (agent-updated progress,
read-only), `note`.

## Relay server and CLI worker

### Relay (`packages/relay`)

Node + `ws`, single file, also shipped as a container. No accounts, no
persistence beyond in-memory rooms (optional bounded replay buffer for
reconnects, phase 4).

Protocol (`PROTOCOL.md`, Zod schemas in
`packages/shared/src/relay/relay-protocol.ts`): JSON control frames
`{ v: 1, t: "hello" | "joined" | "peer-joined" | "peer-left" | "frame" |
"error", room, seq?, payload? }`. For `t: "frame"`, `payload` is base64
ciphertext — the server validates only the envelope and forwards.

Abuse controls: room TTL, max frame size, per-IP token bucket, exactly two
peers per room, no fan-out.

### Pairing and crypto

Happy-Coder trust model — the pairing code *is* the out-of-band channel, so a
symmetric key derived from it is equivalent to (and far simpler to audit than)
a full ECDH handshake:

1. Worker generates a random 32-byte secret.
2. Both sides derive `roomId = HKDF(secret, "room-id")` and
   `key = HKDF(secret, "frame-key")`.
3. Worker prints a pairing code (base58 secret + relay URL), also as QR /
   `metrists://pair?...` deep link. User enters it in the browser.
4. Both join the room by `roomId`; the relay never sees the secret.
5. Frames: XSalsa20-Poly1305 (`tweetnacl`) with per-direction counters in the
   nonce (replay protection).
6. First encrypted frame each way is a challenge/ack proving key possession
   before any ACP traffic. Rekey = re-pair.

The hosted relay is still treated as untrusted; E2E makes that acceptable.

### CLI worker (`notefig agent`)

Lives in `packages/cli` (users already install `notefig`; one install covers
publish + worker; the relay client is small and shared types come from
`@notefig/shared`). It is deliberately thin — four responsibilities, zero
protocol awareness:

1. Connect to the relay, print the pairing code, complete challenge/ack.
2. Supervise adapter processes: `ctl start-task` spawns one, `stop-task`
   kills one, exits are reported as `task-exit` events.
3. Pump bytes: each process's stdio lines ↔ encrypted `acp` frames tagged
   with its `taskId`.
4. Watch `--dir` with chokidar and publish change events on the `watch`
   channel.

It never parses a JSON-RPC message. If the worker needs a change when the
ACP spec evolves, something is wrong with the layering.

## Desktop process host (Rust)

`packages/desktop/src-tauri/src/agent_proc.rs` — custom commands, **not**
`tauri-plugin-shell`: the shell plugin's sidecar model targets bundled
binaries and its scoped `execute` doesn't fit user-configured commands with
persistent stdin streaming. We need line-buffered stdout events, long-lived
stdin, and kill-on-teardown.

- `spawn_agent { proc_id, program, args, cwd, env }` → errors-as-values
  (`AgentProcError` mirroring the `FsError` style)
- `write_agent_stdin { proc_id, line }`
- `kill_agent { proc_id }`
- Emitted events: `agent-proc://{procId}/stdout-lines`, `…/stderr-lines`,
  `…/exit`. The two line topics carry a *batch* (`string[]`, newlines
  stripped, read order preserved) rather than a single line — see
  `src-tauri/src/line_pump.rs` for why they are coalesced. The transport
  re-expands batches into per-line callbacks, so `AgentTransport.onLine`
  and everything above it are unaffected.

All spawned processes are killed when their window/app closes. One process
per task: `proc_id = taskId`, so N parallel tasks are N children under the
same supervisor — no extra machinery.

## Precedents

| Precedent | Borrow | Avoid |
| --- | --- | --- |
| [opencode](https://github.com/anomalyco/opencode) | Prefixed time-sortable ids (ascending/descending); Session→Message→Part hierarchy with client-minted message ids; durable-vs-live event split; per-session serialization with parallel sessions; steer/queue prompt delivery; parentID child sessions for subagents; snapshots anchored to message steps | Mid-migration dual architecture (v1 files + v2 SQLite); 48-bit time field that wraps sort order (~2.2 y) — we widened to 64-bit |
| [Zed ACP client](https://zed.dev/docs/ai/external-agents) | Agent-as-configured-command registry; capability-gated features; render permission options verbatim | Session-per-pane coupling — we key sessions to the workspace |
| [claude-code-acp](https://www.npmjs.com/package/@zed-industries/claude-code-acp) | Spawn as-is (npx/bunx); proof the adapter handles auth + MCP translation | Forking it; treat all adapters as opaque |
| [Happy Coder](https://happy.engineering/docs/how-it-works/) ([security](https://happy.engineering/docs/security/)) | Dumb E2E relay; out-of-band secret via QR/code; challenge auth; self-host story | Harness-specific protocol; account features in the core path |
| VS Code tunnels / code-server | Reconnect-with-replay-buffer semantics; "any relay URL" configuration | Identity-heavy auth (GitHub) — contradicts no-accounts |
| Marimo / Jupyter | State lives in the file; stable cell IDs as addresses (≈ blob IDs) | Kernel/execution-state coupling — blobs must stay valid as dead text in any renderer |
| GitHub Spec Kit / goose | Spec-as-living-artifact framing for docs-drive-agents | Their docs stay passive prompts; nothing mechanical to reuse |

## Phasing

Detailed per-phase execution plan (goals, boundaries, unknowns, patterns,
tests): [agent-harness-phases.md](./agent-harness-phases.md).

1. **Desktop local ACP** — shippable as "chat that edits your docs", with
   parallel tasks from day one: `agent_proc.rs`, TauriStdioTransport, ACP
   client, TaskManager/AgentTask, task-keyed collections, permission UI,
   write-gate through the existing watcher/DocumentSync path. Harness:
   claude-code-acp only.
2. **Blobs** — shared codec + registry + node view + question/approval/status;
   answered-blob → continuation-prompt loop with blob→task attribution.
3. **Relay + CLI worker** — web parity: relay package, pairing crypto,
   `notefig agent` (thin: supervise + pump + watch), RelayTransport.
4. **Depth** — MCP interaction server (upgrade from prompt-guided fences),
   terminals (Rust pty + capability flip), `session/load` resume,
   multi-harness settings UI, relay reconnect replay.

## Risks and deferrals

- **ACP maturity** — the spec is young (`usage_update`, session modes still
  evolving). Pin the npm lib; isolate every protocol type behind
  `acp-types.ts`.
- **Harness auth** — adapters rely on the harness's machine login
  (`claude login`). Web mode: auth happens where the worker runs; needs
  explicit UX. `authenticate` support varies by adapter.
- **Concurrent writes** — last-writer-wins can drop a keystroke burst if an
  agent rewrites a file mid-edit, and parallel tasks raise the collision
  odds. Mitigations: per-file serialization + task attribution in the write
  gate, ID-addressed blob patches, and UI overlap warnings; true diff3 merge
  and worktree isolation are known deferrals.
- **Web-mode writes are unmediated** — with `fs: false` the harness writes
  natively; the app only adopts via the watch channel, so desktop and web
  differ in arbitration latency. Accepted cost of the thin worker; revisit
  only if real conflicts show up in practice.
- **Spawn security** — harness commands come from settings, gated by
  per-workspace trust confirmation on first run; never from document content.
- **Public relay abuse** — rate limits + TTL; hosted relay treated as
  untrusted (E2E) and DoS-limited.
- **YAML fidelity** — answer patches must preserve unknown keys/comments;
  property tests on `patchBlobInMarkdown` round-trips are mandatory.
- **Web split-brain** — v1: the worker owns the folder; browser does not also
  mount it. Documented limitation, revisit after phase 3.
