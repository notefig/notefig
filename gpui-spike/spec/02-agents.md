# Spike 02 — AI harness interactions (agents) on Rust/GPUI

Scope: everything between "user types a prompt" and "a harness process does
work and the app shows/persists it". Editor internals (TipTap/ProseMirror),
git/history, and the app shell are other spikes; this spec names where it
depends on them.

Source of truth read: `packages/agent/src`, `packages/shared/src/agent`,
`packages/desktop/src/modules/{agents,harness-adapters,prompt-rounds,prompt-widgets,turn-writes,shared-sessions,usage,directives}`,
`packages/desktop/src/components/agent`, `packages/widgets/src/{prompt,diff-block}`,
`packages/desktop/src-tauri/src/{agent_proc,mcp_bridge,line_stream,app_status,db_ops}.rs`,
`sidecars/`, `packages/cli/{commands/agent.command.ts,lib/agent-worker.ts}`,
`packages/shared/src/tunnel`. (`modules/session` is NOT agent code — it
persists the last app URL in KV; ignore for this slice.)

Size of what is being ported (non-comment, non-blank lines):
~12.9k logic (agent pkg + agent modules + shared/agent + tunnel),
~9.0k UI (`components/agent/*`, `widgets/src/prompt/**`), ~11.8k tests.
`agent-service.ts` alone is 2.5k lines; `mock-harness.ts` 1.1k.

---

## 1. Harnesses and how they are launched

### 1.1 Architecture in one paragraph

The app is the **sole ACP client** on every platform. A harness is an ACP
*agent* process speaking newline-delimited JSON-RPC 2.0 over stdio. Rust
(`agent_proc.rs`) and the CLI worker are protocol-ignorant byte pumps; all
protocol logic is TS in the webview (`packages/agent/src/acp-client.ts`,
`NotefigAcpClient` over `@agentclientprotocol/sdk` ^1.5 `ClientSideConnection`).
The seam is `AgentTransport` (`packages/agent/src/agent-transport.interface.ts`):
`start/send(line)/onLine/onClose/onDiagnostic/close`, `locus: "local"|"remote"`,
optional `agentCwd`. Implementations: `TauriStdioTransport`
(`modules/agents/tauri-stdio-transport.ts`, local child), `TunnelTransport`
(`modules/agents/tunnel/tunnel-transport.ts`, web → `notefig agent` CLI worker),
`LoopbackTransport` (tests) and the mock harness (`mock-harness.ts`, gated by
`VITE_AGENT_MOCK`). A second seam, `McpEndpoint`, carries the app's own MCP
tool server (multiplexed request/`respond` pairs, not a line channel).

### 1.2 Built-in harnesses (`packages/shared/src/agent/harness-config.ts` `BUILT_IN_HARNESSES`)

| id | command / args | probe | MCP registration | adapter file | usage reporting |
|---|---|---|---|---|---|
| `claude-code` | `sidecar:claude-agent-acp` (bundled), no args | `command -v claude` | `session-new` (ACP `session/new.mcpServers`) | `harness-adapters/claude-code.ts` | cost ✔, limits ✔ (`_claude/rateLimit` on `usage_update._meta`) |
| `opencode` | `opencode acp --cwd ${workspace}` | `command -v opencode` | `opencode-config`: JSON merged into `OPENCODE_CONFIG_CONTENT` env (`mcp.notefig = {type:"local",command:[…]}`) | `opencode.ts` | cost ✔, limits ✘; catalog via `opencode models` (not a probe session — OpenCode can't delete sessions) |
| `devin` | `devin acp` | `command -v devin` | `devin-config`: writes a devin project config under `<ws>/<APP_DIR>/` and passes `additionalDirectories:[that dir]` in `session/new`/`session/load` | `devin.ts` | cost in **credits** (`cognition.ai/totalCreditCost`), per-request usage summed; `clientMeta {"cognition.ai/subagentSupport":true}`; subagent chunks tagged `cognition.ai/subagent_context` and filtered |
| `gemini-cli` | `gemini --experimental-acp` | `command -v gemini` | `none` | `gemini-cli.ts` | nothing (`NO_REPORTING`) |

Custom harnesses: user-defined rows (`CustomHarnessEntrySchema`) with
command/args/env/probe/resume + an `mcpRegistration` mode that picks one of
the adapters above as their dialect. Built-ins can be overridden per machine
(`HarnessOverrideSchema`: command, args replace, env merge, probe, resume,
enabled). Every harness definition can carry `authHint` and a
`resumeCommand` template (`cd ${workspace} && claude --resume ${sessionId}`),
rendered with POSIX or PowerShell quoting (`buildHarnessResumeCommand`).

### 1.3 The bundled Claude sidecar (`sidecars/`)

- `sidecars/claude-agent-acp/package.json` pins `@agentclientprotocol/claude-agent-acp@0.81.2`
  (built on the TS-only Claude Agent SDK). `entry.mjs` runs `runAcp()`, sets
  `CLAUDE_CODE_EXECUTABLE` to the user's `claude` found on PATH (PATHEXT-aware)
  so the ~200 MB native CLI is never shipped, and adds `usage-report.mjs`
  (reports account rate limits after each turn).
- `sidecars/bundle.mjs` esbuilds it to one CJS file; desktop
  `scripts/build-sidecars.mjs` turns that into a **Node 22 single-executable
  application** (`postject`), codesigns it, self-tests it (must answer ACP
  `initialize`), and Tauri ships it via `bundle.externalBin:
  ["binaries/claude-agent-acp"]` (`<name>-<target-triple>`). The CLI vendors the
  same bundle and runs it with its own node.
- Host resolution: `sidecar:<name>` → sibling of `current_exe()`
  (`agent_proc.rs::resolve_sidecar_program`).

### 1.4 Process host (`src-tauri/src/agent_proc.rs`, 1.1k lines — already Rust)

Commands: `spawn_agent(program,args,cwd,env)`, `write_agent_stdin`,
`kill_agent`, `run_shell_command(script)` (login shell, for install probes and
`opencode models`). Behaviour worth keeping verbatim:

- **PATH**: macOS GUI apps get a bare PATH → cached `$SHELL -ilc` probe between
  sentinels (timeout generous; failure ⇒ `shell_env_unavailable`, nothing
  spawned, re-probe next time). Windows: live registry read of system+user PATH
  each spawn; bare program names resolved with PATHEXT (`.cmd` shims →
  CVE-2024-24576-safe std path). Linux: inherited.
- **Env scrub**: remove `CLAUDECODE` / `CLAUDE_CODE_*` guard vars (adapter
  refuses to run "inside another Claude Code session"), except
  `CLAUDE_CODE_EXECUTABLE`.
- **Kill tree**: Unix `process_group(0)` + `killpg`; Windows Job Object. All
  children killed on `RunEvent::Exit`.
- **Streaming**: stdout/stderr are *pull* streams (`line_stream.rs`, doorbell
  event + `pull_stream_lines`) only because of webview IPC limits (payloads
  amplified ~6×, oversized frame crashed WebContent). Irrelevant natively.
- Exit event only after stdout drained, so exit never overtakes lines.

### 1.5 MCP tool bridge (`src-tauri/src/mcp_bridge.rs`, already Rust)

Per task: loopback TCP listener + random token. The harness is given an ACP
`McpServer::Stdio` whose command is **this same app binary** re-invoked with
`--mcp-stdio-relay <port>` (env `NOTEFIG_MCP_TOKEN`); the relay connects back,
presents the token as its first line, then pumps lines. Multiple concurrent
relay connections per task are normal (OpenCode spawns 3). Server name
`notefig` (`MCP_SERVER_NAME`); tool names arrive as `mcp__notefig__x` (Claude)
or `notefig_x` (OpenCode) and are stripped by `toolCallTitle`.

### 1.6 Gates and runtime checks

1. **Runtime gate** — `agents.ensureRuntime()`: always true on desktop; on web
   only with a paired CLI worker, otherwise shows the pairing flow
   (`tunnel/connect-flow.ts`, `require-connection.ts`).
2. **Workspace trust gate** — first session per workspace returns
   `{status:"needs-trust"}`; UI confirms, `trust()` writes KV `agent` /
   `trust:<workspaceKey>`. Harness definitions never come from document
   content. The prompt widget shows the trust warning inline
   (`composing{confirmingTrust}` — second Send confirms).
3. **Install discovery** (`harnesses.ts` + `harness-discovery.ts`): at boot, one
   batched login-shell script runs every probe; verdicts persisted on the
   harness row; "couldn't check" (no shell, timeout) never records "not
   installed". Pickers hide harnesses found missing.
4. **Catalog probe** (`harness-probe.ts`): per harness, find models/settings
   and commands before any user session — throwaway session in a non-workspace
   dir (`probeHarnessSession` in agent-service, `autoGrant:false`) or
   `opencode models`; reprobed if never/edited/>1 day; one at a time.
5. **Protocol version**: requests v1, rejects any other negotiated version
   (`SUPPORTED_ACP_PROTOCOL_VERSIONS=[1]`), telemetry on mismatch.
6. **Startup timeouts** on `initialize`, `session/new`, `session/load`
   (`withStartupTimeout`); timeout ⇒ `error`, rejected load ⇒ `unavailable`.
7. **Auth**: `initialize.authMethods` are advertised regardless of login state,
   so auth is only surfaced when a prompt fails with "Authentication required"
   (`needsSignIn`, per-adapter `isAuthError`). Then the task row gets
   `authRequired`, `authMethods`, `authHint`; the failing prompt is *held*
   and new prompts queue without draining; `authenticate(methodId)` or
   "I've signed in" (`retryAfterAuth`) re-queues the held turn
   (`agent:turn-requeued`). A per-harness "signed in" KV mark is written on
   first success.

---

## 2. Protocol surface actually used

### 2.1 ACP — client → agent (requests)

| Method | Where | Notes |
|---|---|---|
| `initialize` | `NotefigAcpClient.connect` | `protocolVersion:1`, `clientCapabilities = { fs:{readTextFile,writeTextFile} (true local / false remote), _meta: adapter.clientMeta }`. **No `terminal` capability** — harnesses use their own shell tools. Reads `authMethods`, `agentCapabilities.{promptCapabilities.embeddedContext, sessionCapabilities.delete}`. |
| `authenticate {methodId}` | `authenticate` | Out-of-band methods (terminal logins) usually reject → show description as instructions. |
| `session/new {cwd, mcpServers, ...sessionParams}` | `newSession` | `sessionParams` = adapter extension fields spread verbatim (devin `additionalDirectories`). Response `modes`, `configOptions`, legacy `models`. |
| `session/load {sessionId, cwd, mcpServers, ...}` | `loadSession` | Revival; history replays as `session/update` *before* the response. Rejection ⇒ `unavailable`. |
| `session/prompt {sessionId, prompt: ContentBlock[]}` | `prompt` | Returns `{stopReason, usage?{inputTokens,outputTokens,cachedReadTokens,cachedWriteTokens,thoughtTokens}, _meta}`. |
| `session/cancel` (notification) | `cancel` | Plus resolve every pending permission as `cancelled`. |
| `session/set_config_option {sessionId, configId, value}` | `setSessionConfigOption` | Native options; response is the new full list. |
| `session/set_mode {sessionId, modeId}` | same, legacy `modes` source | Applied locally after OK. |
| `session/set_model {sessionId, modelId}` | same, via `extMethod` | Pre-1.x unstable surface. |
| `session/close {sessionId}` | `closeSession` | Manual refresh: close+load rebuilds model context too; -32601 ⇒ plain reload. |
| `session/delete {sessionId}` | `deleteSession` | Only if `sessionCapabilities.delete`. |

### 2.2 ACP — agent → client

Requests the client serves:
- `session/request_permission` → `requestPermission`: **auto-grants** `allow_always`
  else `allow_once` (beta product decision); only if no allow option (or
  `autoGrant:false`) → `PermissionBroker` → `agent-permission-requests`
  row → UI card. Response `{outcome:{outcome:"selected",optionId}}` or
  `{outcome:"cancelled"}`.
- `fs/read_text_file {path,line?,limit?}` → `documents.read` (workspace containment
  via `withWorkspaceContainment`, `packages/agent/src/acp-file-system.ts`).
- `fs/write_text_file {path,content}` → `documents.write` — the *adopting* write:
  disk write, then pushes content into any live editor through
  `DocumentSync.prepareAdoption/commitAdoption` (user edit mid-debounce wins).
  Serialized per path; redirected across tab renames (`modules/documents/documents.ts`).
- Not implemented: `terminal/create|output|wait_for_exit|kill|release`
  (a `terminal` tool-call content item renders as a placeholder label only).

`session/update` notifications (`SessionNotification.update.sessionUpdate`) and handling
(`AgentTask.handleTaskUpdate/handleSessionUpdate`, agent-service.ts ~1380–1470):

| kind | handling |
|---|---|
| `agent_message_chunk` | appended to the turn's open `assistant` run through `MarkdownJoiner` (buffers until a safe markdown boundary); closes a thought run. |
| `agent_thought_chunk` | `thought` run (coalesced; OpenCode streams per token). |
| `user_message_chunk` | only on `session/load` replay → `user` entry, resets per-turn plan slot. |
| `tool_call` / `tool_call_update` | task-level coalescing by `toolCallId` into one `tool_call` entry (shallow merge; `title`/`locations` never regress; `locations` derived from `rawInput.path` for MCP tools); announces `agent:tool-call`. Late updates after turn end still land. On turn end lingering pending/in_progress → `completed` or `failed`. |
| `plan` | one live `plan` entry per turn, replaced wholesale. |
| `usage_update` | `{used,size,cost?, _meta}` → context fill, running cost, limits (`adapter.limits(_meta)` → `agent:usage-limits`). |
| `available_commands_update` | task row `commands` + `agent:catalog`. |
| `current_mode_update` / `config_option_update` | folded into normalized config options in the client; task row `configOptions`; `agent:catalog`. |
| anything else | `unknown` entry with raw payload kept. |

Prompt content blocks (`shared/src/agent/prompt-composer.ts` `composePrompt`):
`text`; `resource` (embedded file context for @-mentions) degrading to inline
fenced text when `embeddedContext` is not advertised; `resource_link` to a
`notefig-widget://…` context URI (`packages/agent/src/widget-context-uri.ts`) for
in-document widget prompts. Commands (`@skill:x`) are placed as `/name` by the
adapter (`placeCommands`); `@model:`/effort directives become
`set_config_option` calls right before the turn (`PromptExtras.config`,
`modules/directives`).

### 2.3 App MCP server (`packages/agent/src/mcp-server.ts`, hand-rolled, stateless)

Methods: `initialize`, `ping`, `notifications/initialized`,
`notifications/cancelled`, `tools/list`, `tools/call`, `resources/list`,
`resources/read` (widget-context payloads, `widget-context-resource.ts`).
Tools (`modules/agents/tools/`): `workspace_list_documents`,
`workspace_read_document`, `workspace_open_files`, `document_read_range`
(live editor positions), `widget_respond` (writes the in-document widget's
answer: `answer|issue|single_choice|multiple_choice`, `shared/src/agent/widget-response.ts`),
`history_log`, `history_diff`, `history_checkpoint`, `history_restore`
(`requiresPermission` → goes through the broker, not auto-granted).
Instructions text: `mcp-instructions.ts`.

### 2.4 Usage normalization (`modules/agents/turn-usage.ts`, `adapter.usage: UsageReader`)

Per turn: tokens from `PromptResponse.usage` (Claude: cache reads inside input →
subtracted), or summed per-request `usage_update`s (Devin); per-model split
from adapter `_meta`; cost = delta of running `usage_update.cost` vs baseline;
context = latest main-agent `usage_update`. Results: `TurnUsage` on the turn,
`SessionUsage` total on the task row, `agent:usage` emitted.

### 2.5 Web tunnel (`packages/shared/src/tunnel/tunnel-protocol.ts`, `PROTOCOL.md`)

Browser ↔ `notefig agent` CLI worker over WebSocket (`ws://127.0.0.1:<port>` or any
`wss://` via `--tunnel-url`). Plaintext envelope `hello{challenge}` / `error` /
`frame`; frames XSalsa20-Poly1305 under a pairing-derived key (pairing code in
`/pair#<code>` deep link). Frame channels: `ctl` (start-task, task-exit,
task-diagnostic, pair-ack with worker's real `--dir`), `acp` lines, `mcp` lines,
tagged by taskId. 4 MiB frame cap. Remote locus ⇒ `fs:false`; files never cross
the wire; the app adopts the worker's disk changes via the watch channel.

---

## 3. Data model, persistence, events

### 3.1 Stores (all TanStack DB collections today; SQLite = `notefig.db`, tables per collection: `collection_registry` + `{key,value(JSON),metadata,row_version}`)

| Collection | Persisted | Key | Shape / notes |
|---|---|---|---|
| `agent-tasks` | **yes** | `taskId` (`task_`, descending ids) | `AgentTaskRow` (`shared/src/agent/task-state.ts`): workspacePath, harnessId, parentTaskId?, title, status `starting|idle|running|cancelled|error|restored|unavailable`, sessionId?, createdAt, updatedAt (not per chunk), lastSettled{turnId,at,status}, usage: `SessionUsage` (durable). Runtime-only (stripped at boot): authRequired, authMethods, authHint, configOptions, commands. Validated on read (`agent-persistence.ts` zod, passthrough). Boot `reconcile`: live → keep; sessionful w/o runtime → `restored`; sessionless → delete; invalid → delete. |
| `agent-turns` | no | `turnId` (`trn_`, ascending) | status `queued|running|completed|cancelled|error`, stopReason, error, usage. |
| `agent-entries` | no | `evt_` ascending (id order = render order; `createdAt` absent on replay) | type `user|assistant|thought|tool_call|plan|unknown`, text / toolCall (`ToolCallUpdate`) / plan / raw. |
| `agent-permission-requests` | no | `<taskId>_perm_<n>` | title, options (verbatim), status `pending|granted|denied|cancelled`. |
| `harnesses` | yes | harness id | override / custom entry / install verdict / catalog{configOptions, commands}. Legacy KV `harness-settings` migrated once. |
| `prompt-rounds` | yes | turnId | one row per in-document widget round: taskId, workspaceKey, documentPath, prompt, status `live|completed|cancelled|error`, outcome snapshot (answer, summary, error, files changed, saved review ranges). Max 100, 7-day retention; `live` at boot ⇒ cancelled. |
| `usage-buckets` | yes, on-demand load | `usg_` | UTC hour × harness × workspace, `UsageSummary` with byModel; views in `usage/series.ts` (day/week/month/quarter, by harness/model, weekday cache share, average day). |
| `usage-limits` | yes | one per harness | last `UsageLimits` {status ok/warning/blocked/unknown, windows[], usingOverage}. |
| KV | yes | — | `agent/trust:<ws>`, signed-in marks, probe timestamps, composer drafts are in-memory. |

**Transcripts are not persisted.** A restored session rebuilds its transcript
via `session/load` replay into a `ReplayStage`, committed in one swap; a failed
load keeps old rows visible. Per-turn usage dies with a restart; session total
on the row survives.

### 3.2 Runtime objects

- `AgentTask` (agent-service.ts): one per live session; FIFO prompt queue
  (queued prompts get user entry + `queued` turn immediately), held prompt on
  auth, tool-call id map, current turn (`TurnState`: open run, joiner, plan
  slot), usage baselines, MCP endpoint, spawn prep.
- `TaskManager` / `AgentRuntime` / facade `AgentsApi` (`agents.ts`):
  `workspace(ws).start(harness)` (gates), `startTask`, `createTask` (subagent),
  `task(id).prompt/promptFromWidget/removeQueuedPrompt/cancel/cancelTurnAndForget
  (Escape restores prompt to composer)/revive/refresh/delete/respondPermission/
  authenticate/retryAfterAuth/setConfigOption/isReachable`.
- `SharedSessions` (`shared-sessions.ts`): one lazily started per-workspace
  session that all in-document prompt widgets queue into; `drop` (rotate, no
  eager spawn, old task not cancelled), `adopt`, `peek`.
- `TurnWrites` (`turn-writes.ts`): attributes editor adoptions to a prompt
  round. In-flight mutating tool calls per path + on settle read back the file
  and record its hash as that round's; an adoption of exactly those bytes gets
  `PROMPT_CHANGE_META`. Needed because Claude Code writes to disk itself
  (watcher adoption arrives after the tool call reports done). Not persisted.
- Directives (`directives.ts`): `@<ns>:<value>` registry; namespaces turn
  values into `PromptExtras` (`commands`, `config`).

### 3.3 Hooks (`modules/agents/agent-events.ts`, plus widgets)

`agent:tool-call {taskId,turnId,workspacePath,toolCall}` (not on replay) →
turn-writes, editor presence · `agent:turn-completed {…,prompt,harnessId}` →
history checkpoint · `agent:turn-requeued` · `agent:turn-settled
{status,at}` → prompt-rounds, seen/attention, turn-writes ·
`agent:usage {…,at,usage}` → usage buckets · `agent:usage-limits` → usage-limits ·
`agent:catalog {configOptions?|commands?}` → harness rows (configOptions only —
commands may be workspace skills) · `widget:round-started` (prompt-widgets) →
prompt-rounds.

---

## 4. UI surfaces and states

- **Chat tab** (`components/agent/agent-chat-tab.tsx`, 1.3k lines): dockable,
  pinned to one taskId, survives unmount (state in collections; drafts in
  `composer-draft-store.ts`). Virtualized transcript of entries: user bubble
  (+ `QueuedBadge`, per-turn usage footer), assistant markdown, collapsible
  thought, `PlanView`, `ToolCallCard` (status icon pending/in_progress/
  completed/failed, title, kind, content items: `content`, `diff` (+/− header and
  preview, or full diff-block card via `renderDiffToolCall` in
  `widgets/src/diff-block/transcript.tsx`), `terminal` placeholder), widget tool
  calls rendered specially (`renderPromptToolCall`). Scroll-to-end button,
  `UnavailableCard` (revival failed: read-only + delete + copy resume command),
  auth card, permission card at the head of the queue, floating `PromptBox`
  composer (send / stop / queue; Escape cancels-and-forgets an unanswered turn).
- **Task status** glyph vocabulary (`status-glyph.tsx`): sign-in > status;
  settled = hairline ring, asking = filled dot, moving = orb. Same glyphs in
  sessions panel, Everything view, and macOS menu-bar status
  (`app_status.rs`, model published by frontend).
- **Session config bar** (`session-config-bar.tsx`): one combobox per advertised
  select option, only `model` and `thought_level`/effort categories shown;
  cmdk filter for long lists (OpenCode). Hidden for `restored` rows.
- **Session usage** (`session-usage.tsx`): context fill vs window in composer
  footer; click → spend breakdown.
- **Permission card** (`permission-card.tsx`): title + ACP options verbatim,
  emphasis by `kind` (allow_once/allow_always/reject_once/reject_always).
- **Auth card** (`auth-card.tsx`): methods off the row, authenticate button,
  hint text, "I've signed in" retry. Also hosted inside the prompt widget.
- **Sessions panel** (`sessions-panel.tsx`): workspace sessions by
  `updatedAt`, live status; `+` split button = harness picker (configured,
  found) behind trust gate; opens chat tab.
- **Harness settings** (`harness-settings.tsx` + `harness-settings-form.ts`):
  list with found/not-found dot, logo (`adapter.logo` SVG paths), enable
  switch, inline edit form (command/args/env/probe/resume), add custom entry,
  rescan.
- **Usage settings** (`usage-settings.tsx` 1.5k + area/bar/radar charts):
  ranges, group by harness/model, top-3 + Other, greyed where a harness can't
  report cost/limits, limit windows.
- **In-document prompt widget** (`packages/widgets/src/prompt/**`, host in
  `components/agent/prompt-widget-host.tsx`): a TipTap node with its own
  mini-composer (mentions `@file`, directives), state machine in `machine.ts`:
  `composing{confirmingTrust}` → `sending` → `working{queued|running}` →
  `asking{permission|auth|question}` → `settled{done|error|cancelled}`;
  `capabilitiesOf(state)` drives keys/deletion/Escape. Answers arrive through
  `widget_respond` (single/multiple choice render as numbered options).
  **Diff review**: a round's edits are tracked as ranges in the doc
  (`change-tracking.ts` ProseMirror plugin mapping spans through later
  transactions; `change-store.ts` persisted per round as "saved review ranges";
  `change-gutter.ts` bars; `change-navigator.ts` review mode from file chips;
  minimap marks). There is no accept/reject — review = highlight + navigate;
  undo is history/`history_restore`.

---

## 5. Rust / GPUI port

### 5.1 Recommended split

Keep vendor adapters as external processes; rewrite the *app-side* agent
layer in Rust. Proposed crates (no gpui dependency except the last):

1. **`nf-agent-proc`** (native only): lift `agent_proc.rs` + `mcp_bridge.rs`
   almost unchanged minus Tauri: spawn with `async-process`/`smol::process`
   (GPUI's executors are smol-based; tokio needs a side runtime thread — fine
   but unnecessary), PATH probe, env scrub, sidecar resolution, process-group /
   Job-Object kill, `--mcp-stdio-relay` mode in `main()`. Delete
   `line_stream.rs` (pull streams were a webview workaround). Output: a
   `Transport` = `(AsyncWrite stdin, AsyncRead stdout, stderr lines, exit fut)`.
2. **`nf-agent`** (target: native + wasm32): ACP client and task runtime.
   - Use **`agent-client-protocol`** (Apache-2.0, the crate Zed uses):
     `ClientSideConnection::new(impl Client, outgoing: AsyncWrite, incoming:
     AsyncRead, spawn)`; `Client` trait is `?Send` async — fits GPUI's
     foreground executor (`cx.spawn`). Implement `request_permission`,
     `read_text_file`, `write_text_file`, `session_notification`; return
     method-not-found for `terminal/*` (as today).
   - Port `acp-client.ts` config normalization (config/mode/legacy-model
     sources), `AgentTask` (queue, held prompt, auth block, turn state, run
     coalescing, tool coalescing, lingering-tool sweep, replay stage, startup
     timeouts), `MarkdownJoiner`, `composePrompt`, `placeCommands`, usage
     normalization, harness config + quoting, harness adapters as a
     `trait HarnessAdapter` with 4 impls + custom → mode mapping.
   - MCP server: either keep the hand-rolled 8-method JSON-RPC handler
     (~380 TS lines → ~400 Rust) or use `rmcp` over a custom transport.
     Hand-rolled is simpler (stateless, one connection = one `respond`).
   - Tools as `trait AgentTool { name, title, schema (schemars), requires_permission, execute }`.
3. **`nf-agent-store`**: tasks/harnesses/prompt-rounds/usage persisted with
   rusqlite (read the existing TanStack tables — JSON `value` column, key
   `s:<id>` — once for migration, then own schema); turns/entries/permissions
   in memory. Wrap as GPUI `Entity<AgentStore>` with per-task change events;
   views `cx.observe` the task they show. This replaces TanStack live queries;
   joins (attention, Everything view) become plain functions over the store.
   Hooks → a typed event bus (`EventEmitter` on core entity or a
   `broadcast` channel) carrying the same 8 events.
4. **`nf-agent-ui`** (gpui + gpui-component): chat tab, composer, pickers,
   permission/auth cards, sessions panel, harness settings, usage settings.
   Use gpui `list()`/`uniform_list` virtualization; batch streamed chunks per
   frame (coalesce notifications, `cx.notify` at most once per frame per
   task). Markdown: gpui-component's `TextView`/markdown (Apache) — **do not
   copy Zed's `markdown`, `acp_thread`, `agent_ui`, `agent_servers` crates: they
   are GPL-3.0** (gpui itself is Apache). Reading them for design is fine.

### 5.2 Node sidecar: keep or rewrite?

- **Keep** `claude-agent-acp` as the Node SEA executable — it is a thin ACP
  shell over the TS-only Claude Agent SDK; there is no Rust equivalent and
  rewriting it means re-implementing Claude Code's SDK. Build pipeline
  (`sidecars/bundle.mjs`, `build-sidecars.mjs`, signing + self-test) moves
  as-is; only the packaging step changes from Tauri `externalBin` to
  copying `claude-agent-acp` beside the GPUI binary in the `.app`/installer.
  Node remains a *build-time* dependency (SEA embeds node; ~100 MB binary).
- OpenCode/Devin/Gemini are user-installed binaries — unaffected.
- **Do not** keep the TS app-side layer (agent-service, MCP tools) as a Node
  "agent host" sidecar: its tools need live editor state (`document_read_range`,
  `widget_respond`, adoption into open editors, history), which now lives in
  Rust, so every tool call would RPC back across the process boundary; the
  TanStack-DB store would be duplicated. Net negative.
- Optional later: Zed-style downloadable Node runtime + npm adapter install
  instead of SEA (smaller app, more moving parts). Not for MVP.

### 5.3 Web (wasm) story

- No process spawn, no TCP listener in wasm. `nf-agent` must compile to
  `wasm32-unknown-unknown` with a `Transport` impl over `web-sys` WebSocket:
  the **existing tunnel** (`notefig agent` worker, XSalsa20-Poly1305 via the
  `crypto_secretbox` crate, same frame format) — protocol stays in the client,
  worker stays a byte pump, `locus=remote` ⇒ `fs:false`, `agentCwd` from
  pair-ack. The CLI worker can stay Node (it already ships the sidecar bundle)
  or be rewritten as a small Rust daemon reusing `nf-agent-proc`.
- Verify early: `agent-client-protocol` and its deps build for wasm32 (it is
  futures/serde based; no tokio required) — if not, vendor its schema crate
  and keep a thin JSON-RPC layer.
- Cloud option (later): the worker side runs in a remote sandbox (e.g. the
  Durable-Object build agents already being explored) — same tunnel, different
  host. GPUI's web target is itself experimental; agents are not the blocker
  there.

### 5.4 What maps trivially vs needs design

Trivial/mechanical: harness config + quoting, usage math + series views,
config normalization, permission broker (oneshot channels), trust KV,
discovery batching (one login-shell script), PATH/kill/relay (already Rust),
tunnel crypto.
Needs design: reactive store replacing TanStack live queries + replay staging;
streaming render perf (markdown incremental parse, long transcripts);
document adoption + turn-writes attribution (depends on editor spike's
document/transaction model — `PROMPT_CHANGE_META` becomes an editor
transaction tag); in-document prompt widget and change-review gutter
(entirely dependent on the editor spike — a block element with an embedded
composer and range-tracking through edits); test infra (mock ACP agent as a
Rust in-process `AgentSideConnection` over a duplex pipe; the Playwright
agent e2e suite does not carry over).

### 5.5 Risks (ranked)

1. **Prompt widget + change review are editor-coupled** (ProseMirror node
   views, position mapping, `PROMPT_CHANGE_META`). Their port cost and shape
   are set by the editor spike; agent parity cannot ship before it.
2. **Rust ACP crate parity with TS SDK ^1.5**: the app uses newer/unstable
   surfaces (`session/close`, `session/delete`, `session/set_config_option`,
   `config_option_update`, `usage_update` cost/size, legacy `set_model` via
   ext method, `_meta` everywhere). Some sit behind `unstable` cargo features
   or may lag; fallback is `ext_method`/raw JSON. Pin and test against
   claude-agent-acp 0.81.2, opencode, devin on day 1.
3. **GPL contamination**: Zed's ACP UI/thread code is the obvious template and
   is GPL-3.0. Clean-room only.
4. **Streaming UI performance** in GPUI (per-token OpenCode thoughts, big tool
   diffs, long revived transcripts) — no DOM virtualization/CSS to lean on;
   markdown rendering quality vs today's.
5. **Test coverage loss**: ~11.8k lines of Vitest + agent e2e over the mock
   harness must be rewritten; behavioural subtleties (late tool updates,
   replay swap, auth hold/requeue, Escape-forget, cancelled-turn late usage)
   are encoded only there.
6. **Sidecar packaging/signing** outside Tauri (externalBin naming, hardened
   runtime entitlements for Node SEA — MET-211, Windows install dir).
7. **Web**: GPUI wasm maturity; the tunnel needs a wasm WebSocket + crypto
   transport; remote-locus file adoption depends on a watch channel.
8. Data migration from TanStack SQLite tables (task rows, harness edits, usage
   history) — low risk, must not be forgotten.

### 5.6 MVP subset

Desktop (macOS), chat-tab only, no in-document widgets:
- Harnesses: claude-code (bundled sidecar) + opencode + custom entries;
  install probe; trust gate; harness picker; resume-command copy.
- ACP: initialize, session/new, session/load revival, prompt, cancel,
  set_config_option (+ legacy mode/model), fs read/write with workspace
  containment and editor adoption (via the editor spike's document API),
  permission broker (keep auto-grant policy), auth-required card.
- Transcript: assistant markdown streaming, thoughts, plan, tool-call cards
  with diff content, queued prompts, Escape-forget.
- Persistence: task rows (+ reconcile/restored/unavailable), harness rows;
  session usage total + context meter.
- MCP app tools: workspace_list/read/open_files + relay (no widget/history tools).
- Rust mock agent + unit tests for AgentTask.

Deferred to parity: devin/gemini adapters + catalog probe, history_* tools,
prompt widgets + shared sessions + prompt rounds + turn-writes attribution +
change review, directives (`@model:` / `@skill:`), usage time series +
settings charts + limits, attention/Everything view, menu-bar status, web
tunnel, Windows/Linux hardening.

### 5.7 Effort (one engineer fluent in Rust, learning GPUI; person-weeks)

| Work | MVP | Parity |
|---|---|---|
| `nf-agent-proc` (lift agent_proc/mcp_bridge, async-process, relay) | 1.0 | 1.5 (Windows Job/PATH, Linux) |
| ACP client + config normalization + crate parity checks | 1.0 | 1.5 |
| AgentTask runtime (queue, auth hold, coalescing, replay, timeouts) | 2.0 | 3.0 |
| Store + persistence + migration + event bus | 1.0 | 2.0 |
| Harness config/settings/discovery/adapters | 0.5 | 2.0 (4 adapters, catalog probe, settings UI) |
| MCP server + tools | 0.5 | 1.5 (history, widget_respond, resources) |
| Chat tab UI, composer, cards, pickers, sessions panel | 3.0 | 4.0 |
| Prompt widget, shared sessions, rounds, turn-writes, change review (editor-dependent) | — | 5.0 |
| Usage series + settings charts + limits | 0.3 (meter) | 2.0 |
| Directives / mentions in composer | — | 1.0 |
| Mock agent + tests | 1.0 | 3.0 |
| Sidecar packaging/signing outside Tauri | 0.5 | 0.5 |
| Web tunnel transport (wasm) | — | 2.0 |
| **Total** | **~10.8 pw** | **~29 pw** |

Expect ±30%; the parity number assumes the editor spike delivers a document
model with transaction tagging and block-level node views.
