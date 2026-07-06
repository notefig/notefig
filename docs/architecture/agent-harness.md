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
  **CLI worker** (`metrists agent`) running on the user's machine.

Everything is open source. The relay is a spec, not a service: the app can
point at any relay URL that implements `packages/relay/PROTOCOL.md`.

## Core decisions

1. **ACP (Agent Client Protocol)** is the harness contract. Metrists is an ACP
   *client*; harnesses connect through their existing ACP adapters
   (`@zed-industries/claude-code-acp`, `gemini --experimental-acp`, …). A
   future Metrists-owned harness is just another ACP agent — no fork decision
   needed now.
2. **Deferred blobs** are fenced code blocks with a `metrists:<type>` language
   tag and a YAML payload. They degrade to plain code blocks in any other
   markdown renderer and round-trip byte-identically through our codec.
3. **The relay is a dumb encrypted pipe.** It forwards opaque frames between
   exactly two peers, understands nothing above its envelope, requires no
   accounts, and deploys as a single small process/container.
4. **Agent file edits flow through the existing sync machinery** (watcher
   events → `DocumentSync` last-writer-wins). No new merge system.

## Layer map

```
UI (AgentPanel, PermissionCard, Blob widgets)
  ↕ TanStack DB collections / useLiveQuery
AgentService                    per-workspace registry: harness config,
  ↕ typed events                session lifecycle, prompt loop, blob pickup
ACP client layer                ClientSideConnection (official lib) +
  ↕ AgentTransport              MetristsAcpClient (fs/permissions callbacks)
  │
  ├─ TauriStdioTransport        desktop: invoke → src-tauri agent_proc.rs
  ├─ RelayTransport             web: WebSocket + E2E-encrypted frames
  └─ LoopbackTransport          tests: in-memory pair
                                     │
                              packages/relay (dumb pipe: rooms, TTL, limits)
                                     │
                              CLI worker `metrists agent`
                              spawns harness, serves fs/* + terminal/* locally,
                              forwards permissions/updates, watch side-channel
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
| `fs/read_text_file` | `platformAdapter.readFiles([path])` + line/limit slicing in TS; `BatchResult` failures become JSON-RPC errors carrying the `FsError` message |
| `fs/write_text_file` | **AgentWriteGate** → `platformAdapter.writeFiles` → standard content-change event so `DocumentSync` arbitrates against open editors |
| `session/request_permission` | **PermissionBroker** (promise-per-request queue) → UI card rendering the agent-provided options verbatim; remember-choice stored per workspace+tool-kind in KV |
| `terminal/*` | Phase 4. Desktop: new Rust pty commands, capability advertised only then. Web: handled worker-side, never reaches the browser |
| `session/update` (notification) | AgentService writes into TanStack collections (below) |

Client capabilities at `initialize`:
`{ fs: { readTextFile: true, writeTextFile: true } }`, terminal `false` until
phase 4.

### ACP client ↔ AgentService

`AgentService` is a per-workspace singleton registry (same convention as
`git-service-store.ts`). It owns:

- **Harness config** — which ACP adapter command to spawn, from
  `HarnessDefinition` (shared Zod schema); built-ins plus user-configured
  commands. A workspace-trust confirmation is required before the first spawn
  in a workspace; commands are **never** taken from document content.
- **Session lifecycle** — `initialize` → `authenticate` (if the adapter
  reports login needed, surface "finish login in your terminal") →
  `session/new` with `cwd = workspacePath` → prompt loop. `sessionId`
  persisted in KV; `session/load` attempted on reopen when the agent
  advertises `loadSession`.
- **Cancellation** — `session/cancel` notification, then process kill on
  teardown. Cancel resolves all pending permission requests as `cancelled`
  (per spec).
- **Blob pickup** — when a turn is idle and answered blobs are queued, the
  service auto-composes a continuation prompt (see Blobs).

### AgentService ↔ UI state

New local-only TanStack DB collections (`agent-collections.ts`), consumed via
`useLiveQuery` like everything else:

- `agentTurns` — `{ turnId, sessionId, status, stopReason? }`
- `agentEvents` — `{ id, turnId, kind: "message_chunk" | "tool_call" |
  "tool_call_update" | "plan" | "usage", payload }`; message chunks are
  coalesced per turn (reuse `src/lib/markdown-joiner-transform.ts` to re-chunk
  streamed markdown at safe render boundaries)
- `agentPermissionRequests` — `{ id, sessionId, title, options, status }`

Tool calls of kind `edit` with diff content render as inline diff cards.

### Browser ↔ relay ↔ CLI worker (web mode)

The one deliberate asymmetry: **bytes stay on the machine that has them.**
The CLI worker intercepts `fs/*` and `terminal/*` client-methods and serves
them locally against its working directory; only `session/request_permission`,
`session/update`, and the prompt/response flow tunnel to the browser. The
worker also runs a chokidar watcher and publishes file-change events on a
side channel, so the browser's content pipeline sees agent edits the same way
desktop watchers do.

Inside the encrypted payload, frames are multiplexed by channel:
`{ ch: "acp" | "watch" | "ctl", ... }` — `ctl` covers worker control
(respawn harness, list harnesses, health).

v1 scope note: in web mode the worker *owns* the folder
(`metrists agent --dir ./book`); the browser does not also mount it through
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
`metrists_await_blob` tool so agents can block on a blob answer mid-turn.

## Deferred blobs

### Wire format

````markdown
```metrists:question
id: q_8f2a
status: pending
prompt: Which pricing tier does this doc target?
options: [Free, Pro, Enterprise]
```
````

- Language tag `metrists:<type>`; body is YAML.
- Canonical envelope (Zod, `packages/shared/src/blobs/blob-envelope.ts`):
  `id` (`/^[a-z]+_[a-z0-9]{4,}$/`), `status`
  (`pending → answered | dismissed | superseded`), `createdBy`
  (`agent | user`), optional `answeredAt`. `.passthrough()` — unknown keys
  are preserved verbatim.
- Invalid YAML or a failed schema parse renders as an ordinary code block
  with error chrome and still round-trips byte-identically.

### Why a code block, not a new node

In ProseMirror the blob **stays a `codeBlock` node** with
`language: "metrists:question"`. The editor schema
(`editor-schema-kit.ts`) and the worker codec are untouched, so the
byte-identical round-trip guarantee holds *by construction* — a blob is a
code block with a fancy node view. `blob-node-view.tsx` decorates code blocks
whose language starts with `metrists:`, parses the YAML lazily, validates
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

**Agent notification:** answered blobs are injected into the next
`session/prompt` as a structured preamble ContentBlock ("The user answered
blob q_8f2a in docs/pricing.md: 'Pro'"). AgentService triggers a continuation
turn automatically when idle with queued answers. The MCP `metrists_await_blob`
tool is the phase-4 upgrade for mid-turn blocking.

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

### CLI worker (`metrists agent`)

Lives in `packages/cli` (users already install `metrists`; one install covers
publish + worker; the relay client is small and shared types come from
`@metrists/shared`). It connects to the relay, prints the pairing code, and on
peer-join spawns the configured harness adapter, piping harness stdio ↔
decrypted frames with the `fs/*`/`terminal/*` interceptor and the chokidar
watch channel described above.

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
- Emitted events: `agent-proc://{procId}/stdout-line`, `…/stderr-line`,
  `…/exit`

All spawned processes are killed when their window/app closes.

## Precedents

| Precedent | Borrow | Avoid |
| --- | --- | --- |
| [Zed ACP client](https://zed.dev/docs/ai/external-agents) | Agent-as-configured-command registry; capability-gated features; render permission options verbatim | Session-per-pane coupling — we key sessions to the workspace |
| [claude-code-acp](https://www.npmjs.com/package/@zed-industries/claude-code-acp) | Spawn as-is (npx/bunx); proof the adapter handles auth + MCP translation | Forking it; treat all adapters as opaque |
| [Happy Coder](https://happy.engineering/docs/how-it-works/) ([security](https://happy.engineering/docs/security/)) | Dumb E2E relay; out-of-band secret via QR/code; challenge auth; self-host story | Harness-specific protocol; account features in the core path |
| VS Code tunnels / code-server | Reconnect-with-replay-buffer semantics; "any relay URL" configuration | Identity-heavy auth (GitHub) — contradicts no-accounts |
| Marimo / Jupyter | State lives in the file; stable cell IDs as addresses (≈ blob IDs) | Kernel/execution-state coupling — blobs must stay valid as dead text in any renderer |
| GitHub Spec Kit / goose | Spec-as-living-artifact framing for docs-drive-agents | Their docs stay passive prompts; nothing mechanical to reuse |

## Phasing

1. **Desktop local ACP** — shippable as "chat that edits your docs":
   `agent_proc.rs`, TauriStdioTransport, ACP client, AgentService,
   collections, permission UI, write-gate through the existing
   watcher/DocumentSync path. Harness: claude-code-acp only.
2. **Blobs** — shared codec + registry + node view + question/approval/status;
   answered-blob → continuation-prompt loop.
3. **Relay + CLI worker** — web parity: relay package, pairing crypto,
   `metrists agent`, RelayTransport, worker-side fs/watch interception.
4. **Depth** — terminals (Rust pty + capability flip), `session/load` resume,
   MCP blob-await tool, multi-harness settings UI, relay reconnect replay.

## Risks and deferrals

- **ACP maturity** — the spec is young (`usage_update`, session modes still
  evolving). Pin the npm lib; isolate every protocol type behind
  `acp-types.ts`.
- **Harness auth** — adapters rely on the harness's machine login
  (`claude login`). Web mode: auth happens where the worker runs; needs
  explicit UX. `authenticate` support varies by adapter.
- **Concurrent writes** — last-writer-wins can drop a keystroke burst if the
  agent rewrites a file mid-edit. Blob patches being ID-addressed and the
  write-gate emitting standard events mitigate; true diff3 merge is a known
  deferral.
- **Spawn security** — harness commands come from settings, gated by
  per-workspace trust confirmation on first run; never from document content.
- **Public relay abuse** — rate limits + TTL; hosted relay treated as
  untrusted (E2E) and DoS-limited.
- **YAML fidelity** — answer patches must preserve unknown keys/comments;
  property tests on `patchBlobInMarkdown` round-trips are mandatory.
- **Web split-brain** — v1: the worker owns the folder; browser does not also
  mount it. Documented limitation, revisit after phase 3.
