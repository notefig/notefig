# Agent Harness — Execution Phases

Companion to [agent-harness.md](./agent-harness.md). Four phases, each
independently shippable. File paths refer to the scaffolding already in the
repo; "implement" means filling a stub, "new" means a file that doesn't exist
yet.

Cross-phase test convention (decided): agent behavior is mocked with
**snapshot transcript fixtures** — plain, searchable files of JSON-RPC
messages piped through `LoopbackTransport` — not a fake agent process. A
small transcript player replays the agent side; assertions snapshot the
client side. Fixtures live next to the tests they serve
(`__fixtures__/*.acp.jsonl`).

```
# example fixture: __fixtures__/simple-edit.acp.jsonl
# ← = agent→client, → = expected client→agent (snapshot-asserted)
→ {"method":"initialize", ...}
← {"result":{"protocolVersion":1,"agentCapabilities":{...}}}
→ {"method":"session/new", ...}
← {"result":{"sessionId":"sess_1"}}
...
```

---

## Phase 1 — Desktop local ACP ("chat that edits your docs")

### Goal

On desktop, a user opens a workspace, opens the agent panel, types a prompt,
and watches Claude Code (via `claude-code-acp`) stream a response and edit
files that update live in the editor — and can start a **second task in
parallel** while the first runs. Minimal surface: one hardcoded harness, a
basic dockable panel with a task list (create/switch/cancel), a plain
confirm dialog for workspace trust, no settings UI, ephemeral history.
Parallelism is structural from day one (everything task-keyed), even though
the v1 UI for it is deliberately plain.

### Architecture

Implement, bottom-up:

1. **`src-tauri/src/agent_proc.rs`** — real process host: `tokio::process`
   children in Tauri managed state keyed by `proc_id`; line-buffered
   stdout/stderr reader tasks emitting batched `agent-proc://{proc_id}/stdout-lines`
   etc.; kill-on-drop and kill-all on app exit.
2. **`tauri-stdio-transport.ts`** — `invoke` + `listen` bridging to the
   `AgentTransport` contract, spawn errors surfaced as `AgentTransportError`.
3. **`acp-client.ts`** — wire `ClientSideConnection` from the official lib
   over `transportToStreams`; `initialize` with capabilities derived from
   transport locus (desktop: fs read/write true).
4. **`agent-service.ts`** — `TaskManager` (per-workspace registry) +
   `AgentTask` (one transport + connection + session + PermissionBroker +
   turn state each; `procId = taskId`). Per task: session lifecycle
   (`session/new` with `cwd = workspacePath`, sessionId persisted to KV even
   though `load` waits until Phase 4), prompt loop, cancellation, fan-out of
   `session/update` into the task-keyed collections — minting `msg_` ids
   client-side (user message at prompt-send, assistant message at first
   update; ids from `@notefig/shared/agent` `ids.ts`), message-chunk
   coalescing via `markdown-joiner-transform.ts`. Prompts arriving while a
   turn runs are **queued** (FIFO, promoted on turn end) — steer-style
   mid-turn interjection is a later upgrade.
5. **UI** — `agent-panel.tsx` registered as a dockable panel: task list
   (create/switch/cancel, running indicator), prompt box, per-turn streamed
   markdown, tool-call rows (inline diff card for `edit` kind),
   `permission-card.tsx` rendering the active task's `PermissionBroker`
   queue head. Workspace-trust confirm (Radix alert dialog) before first
   spawn, remembered in KV per workspace.
6. **`agent-write-gate.ts`** — per-file write serialization with task
   attribution (`writeTextFile(taskId, path, content)`), overlap surface
   for the UI; synthesize the `fs-content-changed` event after writes on
   browser adapters (desktop watcher picks writes up natively); confirm
   `DocumentSync` adoption of agent edits in open editors.

### External interfaces and boundaries

- **ACP** (only new external dependency in play): we call `initialize`,
  `session/new`, `session/prompt`, `session/cancel`; we serve
  `fs/read_text_file`, `fs/write_text_file`, `session/request_permission`,
  `session/update`. Terminal capability stays `false`.
- **Tauri command boundary**: the three `agent_proc` commands + namespaced
  events; errors-as-values matching `fs_ops.rs`.
- **Existing seams touched, not changed**: `IPlatformAdapter` (reads/writes),
  `DocumentSync` (adoption of agent edits), dockable layout (panel
  registration), KV store (trust flag, sessionId).
- Spawn command is hardcoded: `npx -y @zed-industries/claude-code-acp`.

### Known unknowns

- **claude-code-acp auth behavior** when the machine has no Claude login —
  what `authenticate` reports and whether the adapter exits or waits. Spike
  first; drives the "finish login in terminal" affordance.
- **npx cold-start latency** (first run downloads the adapter). May need a
  spawn-progress state in the panel or a bundled-install story later.
- **PATH resolution inside a macOS .app** — GUI apps don't inherit the shell
  PATH; `npx`/`node` may not resolve. Likely need a login-shell PATH probe
  (`$SHELL -lc 'echo $PATH'`) at spawn time. This is the classic
  Electron/Tauri pitfall; solve it in `agent_proc.rs` once.
- Whether `session/update` ordering guarantees let us key events by array
  index or we need defensive reordering by `toolCallId`.
- **Cost of N parallel adapter processes** — memory/CPU of several
  claude-code-acp instances and whether provider rate limits make >2–3
  concurrent turns impractical; may need a soft task cap in TaskManager.

### Industry patterns

- **Zed's external-agent client**: capability-gated features, permission
  options rendered verbatim, agent output as a log of typed rows.
- **Process supervisor pattern** (one owner task per child, channel to
  writers) for `agent_proc.rs` — mirrors how `file_watcher.rs` owns watchers.
- **VS Code's workspace trust** for the first-spawn confirmation.
- Newline-delimited JSON-RPC framing exactly as the ACP lib's stdio helper
  does it — do not invent framing.

### Tests

- **Transcript fixtures through LoopbackTransport** (vitest):
  `simple-turn.acp.jsonl` (prompt → chunks → end_turn),
  `file-edit.acp.jsonl` (agent writes a file; assert write-gate called and
  content-change emitted), `permission-flow.acp.jsonl` (request → user grants
  / denies / cancels; cancel resolves all pending as cancelled),
  `agent-crash.acp.jsonl` (transport closes mid-turn → turn marked error).
- **Parallel-task tests**: two LoopbackTransports replaying different
  fixtures concurrently — events land under the right `taskId`, cancelling
  one task leaves the other's turn and permission queue untouched, write
  gate serializes interleaved writes to the same path and attributes each.
- **Rust (`cargo test`)**: spawn a trivial `node -e` echo process — stdin
  line arrives back in a stdout-lines batch; kill is idempotent; exit event
  fires; spawning a nonexistent binary returns `spawn_failed` as a value.
- **Unit**: `transportToStreams` chunk-splitting/joining edge cases (partial
  lines, multiple lines per chunk); PermissionBroker queue semantics; id
  scheme properties (ascending ids sort chronologically within one ms,
  descending task ids sort newest-first, timestamp decodable — in shared);
  prompt queueing (prompt during running turn is promoted exactly once, in
  order, on turn end).
- **Manual/`verify`**: real end-to-end with Claude Code on a scratch
  workspace — prompt, watch an edit land in an open editor with undo intact.

---

## Phase 2 — Deferred blobs

### Goal

Agents interact with the user *inside the document*: a `notefig:question`
block renders as an answerable widget; the answer is patched into the file
and fed to the agent's next turn. Users see agent progress via `status`
blocks. The round-trip guarantee (blob = code block) is already
test-enforced.

### Architecture

1. **`packages/shared/src/blobs/blob-codec.ts`** — implement
   `parseBlobBlock`, `serializeBlobBlock`, `findBlobs`,
   `patchBlobInMarkdown` using the `yaml` **document API** (comment/order
   preserving). String surgery only; ID-addressed.
2. **`blob-node-view.tsx`** — real node view: extend `CodeBlockLowlight` in
   `tiptap-editor-kit.tsx` with a `ReactNodeViewRenderer` that switches on
   the `language` attr (`metrists:*` → blob widget, else default code view).
   Schema untouched. Lazy parse + registry schema validation; raw-fence
   fallback with error chrome. An "edit as code" affordance flips back to
   the plain code view.
3. **`blob-actions.ts`** — `answerBlob`: authoritative markdown from
   editor-store (open) or disk (closed) → `type.onAnswer` fold →
   `patchBlobInMarkdown` → `DocumentSync.pushUpdate` / `writeFiles`;
   `not_found`/`conflict` → widget re-sync, `superseded` state.
4. **Blob pickup with task attribution** — when a fence is first detected,
   record which task's turn authored it; `notifyBlobAnswered` queues the
   answer on that task, which composes a continuation `session/prompt` with
   a structured preamble ContentBlock per answered blob when idle.
   (Lifecycle ownership: the agent only *authors* the fence; detection,
   rendering, answering, and continuation are all app-owned — see the
   ownership model in agent-harness.md.)
5. **Widgets** — real UI for `question` (options as buttons / free text),
   `approval` (approve/reject + details), `status` (progress chrome),
   plus `choice` and `note` types.
6. **Prompt guidance** — the agent must learn the blob syntax. v1: a system
   preamble block injected into `session/prompt` describing the fence format
   and available types (kept in one shared constant so Phase 4's MCP tool
   can replace it).

### External interfaces and boundaries

- **The blob wire format is a public contract** (other tools/agents may
  write it): envelope schema in `@notefig/shared/blobs` is the spec;
  document it in `agent-harness.md` §blobs as normative.
- Editor boundary: only `tiptap-editor-kit.tsx` changes (node view);
  `editor-schema-kit.ts` and the worker codec must show **zero diff**.
- Agent boundary: blob answers enter ACP purely as prompt content — no
  protocol extension in this phase.

### Known unknowns

- **Will harnesses reliably emit well-formed blob fences from a prompt-level
  instruction alone?** (No fine-tuning, no tool.) Needs an early spike with
  Claude Code; result shapes how much validation/repair the parser needs and
  how soon Phase 4's MCP server matters. Explicit upgrade triggers:
  persistent malformed fences, or a real need for mid-turn blocking.
- **Blob→task attribution edges** — fences arriving via web-mode native
  writes (no write-gate attribution) need best-effort attribution from
  tool-call updates or the fence's authoring turn window.
- **Widget focus vs ProseMirror selection** — interactive node views stealing
  focus is a classic TipTap pain point; budget for `focusArbiter` integration.
- Blob ID generation ownership: agent-invented IDs (spec: prefix + suffix)
  vs client-side repair when the agent emits duplicates/collisions.
- Whether `status` blocks updated rapidly by the agent (many small writes)
  need write coalescing to avoid autosave churn.

### Industry patterns

- **Marimo/Jupyter**: state lives in the file; stable cell IDs ≈ blob IDs;
  outputs must degrade to dead text in any renderer.
- **MDX/remark ecosystem's lesson in reverse**: custom syntax breaks
  portability — fenced code blocks are the only universally safe extension
  point (GitHub renders them as code, pandoc passes them through).
- **CRDT-less conflict handling à la Obsidian**: last-writer-wins at file
  level + ID-addressed micro-patches at feature level.
- **Form-in-document** precedents: Notion synced blocks / Linear issue
  embeds for the widget interaction grammar (answer → collapse to summary).

### Tests

- **Property tests (jest, shared)** on the codec: for arbitrary documents ×
  blob payloads (fast-check), `patch(parse(doc))` preserves every byte
  outside the target fence; unknown keys/comments inside survive; `findBlobs`
  offsets slice exactly the fences. This suite is mandatory per the risk
  register — shared has no tests today, so this also stands up its jest run.
- **Round-trip suite extension** (`blob-roundtrip.test.ts`): fixtures for
  every shipped blob type, nested-in-list/blockquote cases, CRLF documents.
- **blob-actions tests**: answer-while-open (via a real TipTap editor like
  `markdown-codec.test.ts` does), answer-while-closed, agent-deleted-blob →
  `superseded`, concurrent agent rewrite between read and patch.
- **Transcript fixture**: `blob-continuation.acp.jsonl` — turn ends, blob
  answered, service composes continuation prompt (snapshot the preamble).
- **Playwright e2e**: open doc with a pending question blob → click an
  option → file on disk contains `status: answered` with the choice.

---

## Phase 3 — Relay + CLI worker (web parity)

### Goal

A web user pairs their browser with `notefig agent` running on their
machine and gets the Phase 1+2 experience with no desktop install beyond the
npm CLI. Anyone can self-host the relay; the app accepts any relay URL.

### Architecture

1. **`packages/shared/src/relay/pairing.ts`** — implement HKDF-SHA256
   derivation (`room-id`, `frame-key`) + base58 pairing code encode/decode.
   WebCrypto (`crypto.subtle`) so the same code runs in browser and Node;
   `tweetnacl` for XSalsa20-Poly1305 secretbox.
2. **`packages/relay/src/server.ts`** — finish: room TTL, max frame size,
   per-IP token bucket, peer-left on disconnect. Dockerfile + `npx
   @notefig/relay` run story. Publish the package.
3. **`relay-transport.ts`** — WebSocket + frame crypto + per-direction
   counters + challenge/ack; one RelayTransport per task (frames tagged
   `taskId` over the shared socket); demultiplex `acp` to the transport
   surface and `watch`/`ctl` to a new small `remote-workspace-bridge` that
   feeds the existing content-change pipeline and TaskManager.
4. **CLI worker (thin)** — implement `commands/agent.command.ts` +
   `lib/relay-client/`: pairing printout (code + QR), `task-supervisor`
   (ctl `start-task` → spawn one adapter process per task via
   `HarnessDefinition` built-ins, `stop-task` → kill, exits → `task-exit`),
   byte pump per process, chokidar → `watch` channel. **No protocol
   awareness**: web mode advertises `fs: false` at `initialize`, so no
   `fs/*` traffic exists and the worker never parses a JSON-RPC line.
5. **App wiring** — web build: "Connect to your computer" flow (relay URL +
   pairing code entry), workspace = remote (worker-owned folder); reuse the
   agent panel unchanged (transport swap only).

### External interfaces and boundaries

- **`PROTOCOL.md` becomes normative and versioned** — the relay is an
  ecosystem boundary: third parties may implement servers. Envelope schema
  changes require a `v` bump and a compatibility note.
- **Pairing code format is a public contract** (QR / `metrists://pair`).
- **The tunnel carries ACP bytes unmodified and unread** — the worker
  routes frames purely by `taskId`/`ch`; the app is the sole ACP client on
  both platforms, with the desktop/web difference expressed only through
  capability negotiation (`fs: false` on web).
- v1 web scope: the worker owns the folder; the browser does not also mount
  it via File System Access (split-brain deferral, documented).

### Known unknowns

- **Reconnect semantics**: browser tab sleep/wake vs worker-side harness
  still running — does a rejoin resume the ACP session transparently, or do
  we require a fresh `session/new`? (Bounded replay buffer is scoped to
  Phase 4; decide minimum viable reconnect here.)
- **Do we host a default relay?** Product/infra decision: ship with a
  Metrists-hosted default URL (needs abuse budget) or require self-host/
  third-party from day one. Affects onboarding copy and rate-limit tuning.
- Browser WebCrypto HKDF vs Node ≥ 20 parity — verify identical outputs
  early (test vector fixture).
- Worker-side watch fidelity: chokidar event shape → existing
  `ContentChangeEvent` mapping (hashing on the worker to match
  `contentHash` expectations).

### Industry patterns

- **Happy Coder's relay trust model** (implemented faithfully: zero-knowledge
  server, out-of-band secret, challenge before traffic).
- **Magic Wormhole / Syncthing device pairing** for pairing-code UX (short
  code, QR, explicit "paired with <machine>" state).
- **VS Code tunnels** for the reconnect/replay-buffer semantics and the
  "worker prints a URL/code, browser completes" flow.
- **libsodium secretbox + counter nonces** — boring, audited crypto; no
  custom constructions beyond HKDF labels.

### Tests

- **Crypto vectors (shared, jest)**: fixed secret → expected roomId/frameKey
  (cross-checked Node vs browser via vitest in desktop); encrypt/decrypt
  round-trip; replayed frame (repeated counter) rejected; tampered
  ciphertext rejected.
- **Relay server tests**: two ws clients pair and exchange frames verbatim;
  third peer rejected; oversize frame closed; idle room evicted (fake
  timers); peer-left on drop.
- **End-to-end tunnel test (node)**: real relay on an ephemeral port + real
  CLI worker with the harness replaced by the transcript player reading a
  fixture; browser side simulated with RelayTransport in vitest — assert the
  same fixtures from Phase 1 pass over the tunnel unchanged (transport
  symmetry proven by reusing the fixtures).
- **task-supervisor tests**: `start-task` spawns and pumps (transcript
  player as the "harness" binary works unchanged — it's just a process with
  stdio), `stop-task` kills, crash emits `task-exit`, two tasks' frames
  never cross streams.
- **Capability fixture**: web-mode `initialize` snapshot asserts
  `fs: false` is advertised, and a fixture where the agent attempts
  `fs/read_text_file` anyway gets a method-not-supported error from the
  client.
- **Playwright e2e (web build)**: pair → prompt → file changed in worker dir
  → change visible in browser file tree via watch channel.

---

## Phase 4 — Depth

### Goal

Close the loop on everything deferred — headlined by the **MCP interaction
server**, the upgrade from prompt-guided fences to app-mediated interactions
(triggered if fences prove unreliable or mid-turn blocking is needed). Plus
terminals, session resume, multi-harness settings, transcript persistence,
relay reconnect replay. Each item is independent; ship in any order.

### Architecture

1. **MCP interaction server** (headline) — a Metrists MCP server (stdio,
   spawned per session and passed via `session/new mcpServers`) exposing
   `notefig_ask_user` / `notefig_await_blob` / `notefig_upsert_blob`:
   the agent calls a tool, the app materializes/updates the blob and blocks
   the tool result until the user answers — same app-owned lifecycle,
   different authoring channel. Replaces prompt-preamble guidance where
   supported; fences remain the fallback for MCP-less harnesses.
2. **Terminals** — `src-tauri/src/terminal_ops.rs` (portable-pty) mapped to
   ACP `terminal/*`; flip the terminal capability at `initialize` on
   desktop only (web keeps the thin worker; harnesses run commands natively
   there). Panel gets a terminal output view for `tool_call` terminals.
3. **Session resume & transcript persistence** — `session/load` when the
   agent advertises `loadSession`: replay `session/update` history into
   collections on workspace open. Persist transcripts to KV as a fallback
   for harnesses without `loadSession` (supersedes the ephemeral-history
   decision). Persistence follows the durable-vs-live rule (see Identity in
   agent-harness.md): store completed boundaries keyed by `msg_` ids, never
   deltas — the same replay path serves relay reconnect. Steer-delivery
   prompt promotion (mid-turn interjection) lands here too, where harness
   support allows.
4. **Multi-harness settings** — settings UI over `HarnessDefinition` CRUD in
   KV; per-workspace harness selection; auth-state surfacing per harness
   (`authenticate` + `authHint`).
5. **Relay reconnect replay** — bounded in-memory replay buffer keyed on
   `seq` (PROTOCOL.md optional feature becomes implemented+documented);
   RelayTransport resume handshake.
6. **Permission policy** — "always allow X in this workspace" persistence
   (client-side policy over ACP options), with a review/reset surface in
   settings.

### External interfaces and boundaries

- ACP terminal methods + capability flag; MCP server is a new public-ish
  surface (tools an agent can call — document names/schemas as a contract).
- `PROTOCOL.md` v1.1: replay buffer + resume handshake (backwards
  compatible; `v` stays 1 with optional feature negotiation in `hello`).
- Settings/KV schema for harnesses and permission policies (migration-safe:
  version the KV payloads).

### Known unknowns

- **PTY portability** (portable-pty on Windows/ConPTY) and how much terminal
  emulation the panel needs (full xterm.js vs plain scrollback) — scope
  decision when reached.
- **MCP server transport from inside the app**: the ACP `mcpServers` param
  expects a spawnable server — on desktop we can spawn our own binary/node
  script, but wiring its stdio back into the app process needs a bridge
  (likely a tiny sidecar script talking to the app over the same agent_proc
  events). Spike before committing.
- Adapter capability drift (which harness adapters actually implement
  `loadSession`, `authenticate`, terminals) — maintain a support matrix.
- Whether permission "always allow" should be per-tool-kind (ACP `toolKind`)
  or per-tool-name — depends on how adapters populate those fields in
  practice.

### Industry patterns

- **xterm.js + ConPTY/portable-pty** — the standard embedded terminal stack
  (VS Code, Zed).
- **MCP tool servers** — follow the official MCP TS SDK; tool schemas in
  Zod, one server per session, stateless between calls.
- **Capability matrices** (Zed's per-agent feature gating) instead of
  version sniffing.
- **Event-sourced transcript** (append-only event log → derived view) for
  persistence — the collections already model events; persistence is just a
  KV-backed log with replay.

### Tests

- Terminal: cargo tests for pty spawn/kill/resize; transcript fixture with
  `terminal/create` → output → `wait_for_exit`; e2e "agent runs a build and
  shows output".
- Resume: fixture-driven `session/load` replay populates collections
  identically to a live run (snapshot equality with the Phase 1 fixture
  outcome).
- MCP: tool-call round-trip test with the MCP SDK test client;
  `notefig_await_blob` resolves when `answerBlob` fires.
- Relay replay: kill/rejoin mid-fixture; frames after last acked `seq`
  redelivered once, in order, decrypt cleanly.
- Settings: KV schema migration tests (old payload → new shape).

---

## Sequencing notes

- Phase 1 unblocks everything; 2 and 3 are independent of each other after 1
  (blobs never touch the transport; the relay never touches the editor).
- The transcript-fixture suite is the spine: Phase 3 proves transport
  symmetry by re-running Phase 1 fixtures over the tunnel; Phase 4 proves
  resume by replaying them through `session/load`.
- Risk-driven spikes to schedule *before* their phase starts:
  claude-code-acp auth behavior (before 1), blob-emission quality from
  prompt guidance alone (before 2), hosted-relay decision (before 3).
