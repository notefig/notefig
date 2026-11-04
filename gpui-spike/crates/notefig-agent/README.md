# notefig-agent

Notefig's agent layer for the GPUI port: harness registry, process host,
ACP client, task/turn/entry model with persistence, the app MCP server and
its stdio relay. No gpui dependency; runtime-agnostic (smol,
async-channel). Spec: `spec/02-agents.md` §1–3. TS sources it ports are
named at the top of each module.

```
src/
  host.rs        AgentHost / AgentHandle / HostConfig / Pending — the app-facing API
  task.rs        one live session (queue, auth hold, turn state, replay, usage, permissions)
  acp.rs         ACP client (initialize, sessions, config normalization, auto-grant)
  rpc.rs         newline JSON-RPC over any byte streams (single-threaded executor)
  process.rs     login-shell PATH, env scrub, sidecar resolution, process-group spawn/kill, Transport seam
  harness/       definitions, overrides, custom entries, discovery, one adapter per harness
  mcp/           app MCP server (tools, instructions, validation), per-task endpoint, stdio relay
  model.rs       task / turn / entry / permission rows + typed views (ToolCallView, PlanView)
  store.rs       AgentState (live store), Store trait, JsonFileStore, MemoryStore, boot reconcile
  usage.rs       token/cost shapes, turn normalization, hourly buckets, limits merge
  rounds.rs      prompt rounds + turn-write attribution
  prompt.rs      composePrompt, placeCommands, widget-context URI, widget prompt framing
  joiner.rs      MarkdownJoiner
  services.rs    ClientServices seam (ClientRequest / Reply / AppToolCall), ChannelServices, DiskServices
src/bin/notefig-mcp-relay.rs   stand-in for `notefig --mcp-stdio-relay <port>`
examples/smoke.rs              live run against a real harness
tests/fake_agent.rs            runtime over an in-process fake ACP agent
tests/mcp.rs                   MCP endpoint + real relay binary
```

## Using it from the app

### Boot

```rust
use notefig_agent::{AgentHost, ChannelServices, JsonFileStore, host::HostConfig, mcp::RelayCommand};

let (services, requests) = ChannelServices::new();           // ClientRequests arrive on `requests`
let mut config = HostConfig::new(
    JsonFileStore::new(app_support_dir.join("agents.json")),  // tasks, harness rows, usage, rounds, KV
    services,
);
config.relay = RelayCommand::app_exe(std::env::current_exe()?); // harness runs `notefig --mcp-stdio-relay <port>`
let (agents, events) = AgentHost::start(config);              // agent thread starts; install probe + catalog probes run
```

In `main()`, before anything else:

```rust
let args: Vec<String> = std::env::args().skip(1).collect();
if args.first().map(String::as_str) == Some("--mcp-stdio-relay") {
    let port = notefig_agent::mcp::relay::relay_port_from_args(&args).unwrap();
    std::process::exit(notefig_agent::mcp::relay_main(port));
}
```

On app exit: `agents.shutdown().recv_blocking();` (disposes tasks, flushes
the store, kills every child process group). `notefig_agent::process::kill_all()`
is the synchronous last resort for a quit hook.

`HostConfig` fields: `store`, `services`, `relay`, `discover_on_boot`
(default true), `probe_catalogs` (true; stale >1 day or command
changed), `startup_timeout` (60 s per step), `probe_dir`, `transport`
(default `ProcessTransport`; a `TransportFactory` is the seam for tests and a
future web tunnel).

### Rendering: events + snapshot reads

`events: async_channel::Receiver<AgentEvent>` (unbounded — drain it). Row
events carry the whole row; the UI can mirror them or just `cx.notify()` and
re-read through the handle (`AgentHandle` is `Clone + Send`; reads lock the
shared `AgentState` briefly):

| event | meaning |
|---|---|
| `TaskChanged(row)` / `TaskRemoved` | task row (status glyph, title, auth card, config bar, usage meter) |
| `TurnChanged(turn)` / `TurnRemoved` | queued / running / completed / cancelled / error, per-turn usage |
| `EntryChanged(entry)` / `EntryRemoved` | transcript (id order = render order) |
| `TranscriptReplaced { task_id }` | a `session/load` replay committed — re-read entries + turns |
| `PermissionChanged(row)` | permission card (pending → granted/denied/cancelled) |
| `HarnessesChanged` | re-read `harness_settings()` / `pickable_harnesses()` |
| `PromptRoundChanged` / `PromptRoundRemoved` | in-document widget rounds |
| `ToolCall`, `TurnSettled`, `TurnCompleted`, `TurnRequeued`, `Usage`, `UsageLimits`, `Catalog` | the TS `CoreHookMap` moments (history checkpoint on `TurnCompleted`, editor presence on `ToolCall`, …) |
| `Diagnostic { label, detail }` | stderr lines, `mcp <method>` traffic, start/turn warnings |

Reads: `task(id)`, `tasks()`, `tasks_for_workspace(ws)` (by `updated_at`),
`turns(id)`, `entries(id)`, `pending_permissions(id)`, `usage_buckets()`,
`usage_limits()`, `prompt_rounds()`, `harness_settings()`,
`pickable_harnesses()`, `configured_harnesses()`, `harness_catalog(id)`,
`harness_reporting(id)`, `harness_label(id)`, `resume_command(task, dialect)`,
`attribute_write(path, content_hash)`, `peek_shared_session(ws)`,
`is_signed_in(harness)`, or `state()` for the whole `AgentState`.

Typed views for raw payloads: `entry.tool_call_view()` → title (MCP prefix
already stripped), kind, status, `content` (`Content` / `Diff{path,old,new}` /
`Terminal` placeholder), `locations`, `raw_input`; `entry.plan_view()`.

### Commands

Every command is sent at call time; the ones that answer return
`Pending<T>` (`.recv().await` from any executor, `.recv_blocking()`, `.try_recv()`).

```rust
agents.trust(&ws);                                             // trust gate (persisted in KV)
let StartResult::Started { task_id } = agents.start_task(&ws, "claude-code").recv().await.unwrap()
    else { /* NeedsTrust → confirm + trust(); UnknownHarness */ };
// The row exists now (status Starting) — open the chat tab right away.
let h = agents.prompt(&task_id, "Fix the intro", PromptExtras::default()).recv().await.unwrap();
// h.turn_id is in the transcript already (queued); h.completed resolves with TurnOutcome.
agents.cancel(&task_id);
let forgot = agents.cancel_turn_and_forget(&task_id).recv().await.unwrap(); // Escape → restore composer
agents.respond_permission(&task_id, &req.id, PermissionOutcome::Selected(option_id));
agents.authenticate(&task_id, &method_id);                    // then the held prompt re-runs
agents.retry_after_auth(&task_id);                            // "I've signed in"
agents.set_config_option(&task_id, "model", "sonnet");        // restored rows revive first
agents.refresh(&task_id);                                     // session/close + session/load re-sync
agents.delete(&task_id);
agents.dispose_workspace(&ws);                                // sessionful rows → restored
```

`PromptExtras { context_parts, commands, config }` carries what the
composer's directives produced: `@file` mentions (`resource_link` /
embedded `resource`, degrading to fenced text without `embeddedContext`),
`@skill:` commands (placed where the harness runs them — Claude: last block),
`@model:`/effort changes (switched via `set_config_option` right before the
turn). A restored task revives transparently on `prompt` (`session/load`
replay first, the prompt queued behind it).

In-document widgets: `shared_session(ws, harness)` → task id of the
workspace's shared session (started lazily, reused; `drop_shared_session`,
`adopt_shared_session`), `prompt_from_widget(task, text,
WidgetPromptSource{path,pos,is_doc_empty,reference}, extras)` (blockquote +
`notefig://widget-context?...` resource_link, or the empty-doc framing),
`record_round_started(RoundStarted{..})` (`widget:round-started`), rounds
settle with an outcome (widget response, summary, error, touched files) on
their own; `save_round_changes(doc, fingerprint, ranges)` keeps review ranges.
`attribute_write(path, rounds::content_hash(text))` tells which round wrote
what an editor is adopting (in-flight mutating calls, or the md5 the call
left on disk when it settled).

Harness settings: `save_override(id, Some(HarnessOverride{..}))`,
`save_custom(id, CustomHarnessEntry{..})`, `set_harness_enabled`,
`remove_custom_harness`, `rescan_harnesses()` (one login-shell batch; `None`
= couldn't check, nothing recorded), `probe_catalogs(only, force)`.

### ClientServices (what only the app knows)

`ClientServices::handle(ClientRequest)` is called on the agent thread and
must not block; answer through the request's `Reply` whenever ready (from
the UI thread with `ChannelServices`). All paths are absolute and already
contained in the workspace.

```rust
match request {
    ClientRequest::ReadTextFile { path, line, limit, reply, .. } =>      // ACP fs/read_text_file (live editor text)
        reply.send(Ok(editor_or_disk_text(&path, line, limit))),
    ClientRequest::WriteTextFile { path, content, reply, .. } =>         // ACP fs/write_text_file — the adopting write
        reply.send(write_and_adopt(&path, &content)),
    ClientRequest::Tool { call, reply, .. } => reply.send(match call {   // app MCP tools → JSON value or error
        AppToolCall::ListDocuments => Ok(json!([{ "path": "a.md", "type": "file", "title": "a.md" }])),
        AppToolCall::ReadDocument { path, line, limit, .. } => /* text */,
        AppToolCall::OpenFiles => /* {tabs, activeFile, hasSelection} */,
        AppToolCall::DocumentReadRange { path, from, to, .. } => /* {content, from, to, docSize} */,
        AppToolCall::HistoryLog { .. } | AppToolCall::HistoryDiff { .. }
        | AppToolCall::HistoryCheckpoint { .. } | AppToolCall::HistoryRestore { .. } => /* history repo */,
    }),
    ClientRequest::WidgetContext { reference, reply, .. } =>             // resources/read of a widget-context URI
        reply.send(Ok(widget_context_payload(&reference))),
}
```

`widget_respond` is validated and acknowledged inside the crate (the
transcript entry is the record); `history_restore` is permission-gated
through the task's broker before it reaches the app. `DiskServices` is a
plain-disk implementation for headless use and tests.

## What was verified live (2026-10-31, this machine)

`cargo run -p notefig-agent --example smoke -- <harness> <dir> "<prompt>"`
(plus `--revive <dir>`, `SMOKE_MODEL=…`, `SMOKE_PROBE=1`):

- **claude-code** (bundled sidecar `claude-agent-acp` resolved via the dev
  fallback path, driving `~/.local/bin/claude`, with the agent itself running
  inside Claude Code → env scrub needed and working): install probe, spawn,
  initialize, session/new with the MCP server, config options (mode / model /
  effort / fast), available commands, prompt "Create hello.md containing 'hi'
  then call the notefig workspace_list_documents tool" → `hello.md` written,
  `mcp__notefig__workspace_list_documents` round trip through
  `notefig-mcp-relay` → TCP endpoint → `ClientServices` → back to the model,
  tool-call coalescing (pending → completed, prefix stripped, locations),
  `end_turn`, usage (tokens incl. cache, $0.17 cost from the running total,
  context 30.7k/1M), Claude rate-limit windows (`_claude/rateLimit`), resume
  command. Then `--revive`: a fresh host over the same JSON store restored the
  row and revived it via `session/load` — transcript replayed (user, 3 tool
  calls, assistant), status idle. No paid turn needed for that.
- **opencode** 1.18.15: spawn with `--cwd`, initialize, session/new, MCP
  registration via `OPENCODE_CONFIG_CONTENT` (opencode spawned the relay and
  ran MCP `initialize` + `tools/list` against our server), config options,
  commands, `@model:` path (`session/set_config_option` switched the model to
  the requested one). **The turn itself could not complete**: every OpenCode
  credential on this machine is dead (OpenCode API key expired, free limit
  reached, OpenAI OAuth refresh 401, DeepSeek balance 0); the harness's
  error came back as a clean turn error with the message.
- **Catalog probes**: claude-code (throwaway session: 4 options, 244
  commands), devin (session: mode + model, 22 commands), opencode
  (`opencode models`: 295 models). Gemini CLI isn't installed → "missing".
- **File write delegation**: claude-agent-acp writes files itself (no
  `fs/write_text_file` arrived — as the spec notes), so the delegated path is
  covered by the fake-agent test only (`fs_requests_go_through_services_with_containment`:
  write, containment refusal of `../escape.md`, read back).
- No processes left behind after any run.

## Tests

`cargo test -p notefig-agent` — 39 unit tests (config/overrides/resume
quoting, adapters' MCP dialects and usage readers, config normalization,
auto-grant, joiner, tool schemas/validation/repair, containment, store boot
reconcile, usage math, rounds/attribution, discovery script, process group
kill) + `tests/fake_agent.rs` (12: transcript building from every update
kind, FIFO queue, auth hold → authenticate → held turn re-runs first,
permission auto-grant vs app-answered card, cancel of turn + queue,
Escape-forget, fs delegation + containment, config switch + command
placement + MCP server in session/new, restart → restored → revive with
replay, shared sessions, widget prompt rounds) + `tests/mcp.rs` (real relay
binary end to end, token rejection).

## Gaps vs the spec

- **`agent-client-protocol` crate not used.** 3.6.0 was checked (builder /
  actor `Client.builder().connect_with(..)` API, tokio-flavoured examples,
  typed v1 enums without unknown-variant fallback). This layer needs raw
  passthrough (`_meta` everywhere, legacy `session/set_model`, extension
  fields spread into `session/new`, unknown update kinds kept verbatim), so
  the wire is ~250 lines of hand-rolled JSON-RPC (`rpc.rs`), like the TS MCP
  server. It also keeps the crate wasm-friendly.
- **Platforms**: Unix kills the process group (`killpg`). Windows
  (`src/process_windows.rs`, ported from `agent_proc.rs`): live registry
  PATH (system + user, `REG_EXPAND_SZ` expanded) read on every spawn, bare
  names resolved via PATH × PATHEXT so `.cmd` shims take std's strict
  cmd.exe quoting path (CVE-2024-24576), `CREATE_NO_WINDOW`, each child in a
  kill-on-close Job Object (`taskkill /T /F` fallback), case-insensitive PATH
  override in the child env; `run_shell_command` returns "couldn't check" (no
  login shell), so install discovery records nothing. Linux inherits PATH.
  Windows is verified only by `cargo check --target x86_64-pc-windows-msvc`
  (`--all-targets`, clean); its unit tests (PATHEXT, `.cmd` spaced argument,
  registry read) have not run on Windows. Linux is not compiled here (target
  not installed).
- **Web tunnel / remote locus** not implemented; `TransportFactory` is the
  seam (and `AcpClient::connect(fs: bool, ..)` already takes the locus).
- **Catalog probes** follow `harness-probe.ts`: at boot and every 6 h
  (stale only: never probed, command/args/env changed, or >1 day), again
  after a harness is edited / rescanned / re-enabled, one at a time through a
  queue, a 10-minute backoff after a failure for the same definition, and a
  result dropped if the harness was edited mid-probe. Not covered by a test
  (the fake harness has no catalog discovery); verified live before the
  queue rewrite.
- **Env scrub** removes every inherited `CLAUDE_CODE_*` except
  `CLAUDE_CODE_EXECUTABLE` (broader than the TS list, per the brief); a
  harness's own env can set them again.
- **Telemetry** (unsupported protocol version etc.) is a `Diagnostic` event only.
- **Usage**: hourly buckets and limits are kept; the series views
  (day/week/month/quarter, by harness/model, weekday cache share) are not ported.
- **Prompt rounds**: rows, settle-with-outcome, requeue, orphan settle at
  boot, retention and review-range storage are here; the open-workspace join
  (`derivePromptRounds`) and `observeNewest` are left to the app (plain
  functions over `prompt_rounds()`).
- **Directives** (`@model:`, `@skill:` parsing) stay app-side; only their
  result (`PromptExtras`) is consumed here.
- **History tools** are forwarded to the app; it needs the history repo.
- **Migration** from the TanStack SQLite tables (task rows, harness edits,
  usage history) is not done.
- **Permission row status**: selecting a `reject_*` option marks the row
  `denied` (TS marked any selection `granted`).
- Trust/workspace keys are the path string as given (no Windows
  `workspaceKey` case folding). Revival never waits for harness rows (they
  load synchronously at boot), so the TS "waiting revival" path is gone.
- Event volume: `EntryChanged` clones the whole entry per streamed chunk and
  `TaskChanged` fires on every row write; coalesce per frame in the UI.
