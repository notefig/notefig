//! Test-only Tauri `MockRuntime` harness (MET-73).
//!
//! Builds a mock app from the SAME `register_handlers` the real `main` uses, so
//! the dispatch tests exercise the actual command registration — a command that
//! stops being registered breaks these tests. Each test below invokes one
//! representative `#[tauri::command]` per module through the full Tauri IPC path
//! (command name → argument deserialization → handler → serialized response),
//! which nothing else in the repo verifies; the underlying helper functions are
//! covered separately. This is the *dispatch path*, deliberately not a matrix
//! over every command or error branch.
//!
//! `MockRuntime` runs no real OS file watchers or child processes, so these
//! assert on each command's immediate return value, never on runtime side
//! effects (which belong to the shim-backed suite / MET-83).

use serde_json::{json, Value};
use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets, MockRuntime, INVOKE_KEY};
use tauri::webview::InvokeRequest;
use tauri::{App, WebviewWindow, WebviewWindowBuilder};

/// A mock app wired with the production handler list via `register_handlers`.
pub fn mock_app() -> App<MockRuntime> {
    crate::register_handlers(mock_builder())
        .build(mock_context(noop_assets()))
        .expect("failed to build mock app")
}

/// The webview an invoke is dispatched through (commands need a webview target).
pub fn main_webview(app: &App<MockRuntime>) -> WebviewWindow<MockRuntime> {
    WebviewWindowBuilder::new(app, "main", Default::default())
        .build()
        .expect("failed to build mock webview")
}

/// Invoke `cmd` with a JSON argument body through the real IPC dispatch and
/// return the deserialized JSON response (`Ok`) or the error value (`Err`).
/// Argument keys are camelCase (the JS-side convention Tauri maps to snake_case
/// params), matching how the frontend actually calls these commands.
pub fn invoke_json(
    webview: &WebviewWindow<MockRuntime>,
    cmd: &str,
    args: Value,
) -> Result<Value, Value> {
    get_ipc_response(
        webview,
        InvokeRequest {
            cmd: cmd.into(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            url: "http://tauri.localhost".parse().unwrap(),
            body: tauri::ipc::InvokeBody::Json(args),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.to_string(),
        },
    )
    .map(|b| b.deserialize::<Value>().expect("response was not valid JSON"))
}

// ---------------------------------------------------------------------------
// One dispatch test per registered module. Each proves the command name routes
// to its handler and the response serializes back — the seam nothing tested.
// ---------------------------------------------------------------------------

/// fs_ops: `check_exists` reports a nonexistent path as not present. Proves the
/// fs command family dispatches and serializes its Vec<ExistsResult> response.
#[test]
fn fs_ops_check_exists_dispatches() {
    let app = mock_app();
    let webview = main_webview(&app);

    let res = invoke_json(
        &webview,
        "check_exists",
        json!({ "paths": ["/definitely/not/a/real/path/xyz"] }),
    )
    .expect("check_exists should return Ok");

    let results = res.as_array().expect("expected an array");
    assert_eq!(results.len(), 1);
    assert_eq!(results[0]["exists"], json!(false));
}

/// file_watcher: `stop_watching` for an unknown id returns the errors-as-string
/// failure — proving dispatch + the error branch surface through IPC, without
/// needing a real OS watcher (MockRuntime spins none).
#[test]
fn file_watcher_stop_watching_dispatches() {
    let app = mock_app();
    let webview = main_webview(&app);

    let err = invoke_json(&webview, "stop_watching", json!({ "watchId": "nope" }))
        .expect_err("stopping an unknown watcher should be an Err");

    assert!(
        err.as_str().unwrap_or_default().contains("No watcher found"),
        "unexpected error payload: {err}"
    );
}

/// search: an empty query is rejected before touching the filesystem — a cheap,
/// deterministic proof that `search_content` dispatches with its multi-arg body.
#[test]
fn search_content_dispatches() {
    let app = mock_app();
    let webview = main_webview(&app);

    let err = invoke_json(
        &webview,
        "search_content",
        json!({
            "directory": "/tmp",
            "query": "",
            "useRegex": false,
            "caseSensitive": false,
        }),
    )
    .expect_err("empty query should be rejected");

    assert!(
        err.as_str().unwrap_or_default().contains("Query cannot be empty"),
        "unexpected error payload: {err}"
    );
}

/// agent_proc: `kill_agent` is idempotent for an unknown proc id and returns the
/// errors-as-values `{ ok: true }` shape. Proves the agent command family
/// dispatches without spawning a real child process.
#[test]
fn agent_proc_kill_agent_dispatches() {
    let app = mock_app();
    let webview = main_webview(&app);

    let res = invoke_json(&webview, "kill_agent", json!({ "procId": "ghost" }))
        .expect("kill_agent should return Ok");

    assert_eq!(res["ok"], json!(true));
}

/// mcp_bridge: `stop_mcp_relay` is idempotent for an unknown task and returns
/// the errors-as-values `{ ok: true }` shape — proving the MCP bridge command
/// family dispatches through IPC.
#[test]
fn mcp_bridge_stop_relay_dispatches() {
    let app = mock_app();
    let webview = main_webview(&app);

    let res = invoke_json(&webview, "stop_mcp_relay", json!({ "taskId": "ghost" }))
        .expect("stop_mcp_relay should return Ok");

    assert_eq!(res["ok"], json!(true));
}
