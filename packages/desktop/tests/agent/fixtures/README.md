# Agent session recordings

Each `*.json` here is a **notefig-agent-recording** (see
`src/components/debug-panel-recording.ts`): one agent session as the agent→client
events behind it — `session/update` payloads, agent→client requests
(permission, `fs/*`) with the app's reply, optionally MCP `tools/call`s the
harness made against the app's own tools — grouped by turn, with `at`
offsets in ms.

A recording copied from the app is **derived from the transcript** (the
same rows the debug panel's session report shows): one chunk per assistant
or thought entry, each tool call once in its final state, the turn's final
plan, and each permission request with its outcome. Nothing in the live
agent lifecycle is instrumented for it. A hand-authored fixture may spell
out finer frames (streaming chunks, pending → completed transitions,
successive plan revisions) where a test needs them.

The mock harness's `replay` scenario plays a recording back through the
**real** ACP client, agent service, collections and UI. Only the process on
the far side of the transport is fake, so a test against a recording
exercises exactly the code a real Claude / Devin / OpenCode session does.

## Capturing a real one

1. Run the app (any build — the debug panel is always there).
2. Have the session you want to reproduce (the janky todo list, the
   permission that never settled…).
3. Open the debug panel (`?debug=true`), **Session** tab, pick the task, click
   **Recording**. The JSON is on your clipboard.
4. Save it here, and write a test with `replayRecording(page, loadRecording("x.json"))`
   (`tests/agent/agent-helpers.ts`).

Paths under the recorded `workspacePath` are rewritten to the live workspace
on replay; the recorded `sessionId` is replaced by the live one. Agent→client
requests are made for real — the app (or the test, clicking the permission
card) answers them; the recorded `response` is documentation of what happened
originally, not a script.

## Provenance of the current files

All of these were **hand-authored** (2026-09-19) to the shapes the pinned
`@agentclientprotocol/sdk` schema and the claude-agent-acp /
devin / opencode adapters emit, so the workflow suite has something to run
against from day one. Replace any of them with a real capture of the same
scenario — same file name — and the corresponding tests run against the real
frames.

| File | Scenario |
| --- | --- |
| `claude-todo.json` | Claude Code: TodoWrite plan updated 4× across one turn (+ a second turn), Read/Edit/Bash tools, markdown reply |
| `devin-todo.json` | Devin: task list that shrinks and merges between updates |
| `permission-reject-only.json` | A permission request offering only reject options — reaches the card |
| `permission-auto-grant.json` | A permission request with an allow option — blanket-granted, no card |
| `widget-answer.json` | Widget prompts: an `answer` via widget_respond, then a reply flagged as an `issue` |
| `tool-failure.json` | A tool call that fails |
| `turn-error.json` | A turn that errors mid-stream |
| `auth-required.json` | Logged-out harness: turn 1 errors "Authentication required", turn 2 (the retry) succeeds |
| `changed-files.json` | One tool call with three diffs (one new file), a terminal-content tool |
| `streaming-slow.json` | A long stream with 150 ms gaps — replay at `speed: 1` to interrupt/queue |
| `unknown-updates.json` | `available_commands_update` / `current_mode_update` (stored, never rendered) |
| `author-blob.json` | An author_blob tool call (the "authored a question in" card) |
| `file-write.json` | The agent writes an open document via `fs/write_text_file` |
