//! Real-backend e2e shim (MET-73) — TEST INFRASTRUCTURE, never shipped.
//!
//! True Tauri e2e is unattainable on macOS (`tauri-driver` has no WKWebView
//! support). This binary is the pragmatic substitute: it exposes the app's real
//! Rust commands over HTTP so the existing Playwright suite can drive the real
//! UI → real `src/entities` → real Rust commands on a real temp filesystem,
//! instead of the browser IndexedDB adapter.
//!
//! GENERIC DISPATCH: rather than a hand-written arm per command, the shim builds
//! a Tauri `MockRuntime` app from the SAME `register_handlers` the real app uses
//! and routes every `POST /invoke/{cmd}` through Tauri's own IPC dispatch
//! (`get_ipc_response`). So adding a command to `register_handlers` makes it
//! available here automatically — no shim change — and argument deserialization
//! (camelCase → snake_case) and response serialization are exactly production's,
//! not a reimplementation.
//!
//! THREADING: the `MockRuntime` app is not `Send`, so it lives on the main
//! thread running a blocking dispatch loop; the axum server runs on a worker
//! thread. Only JSON values cross between them (over channels), so nothing
//! non-`Send` is shared. Requests are serialized through the one app — fine for
//! e2e.
//!
//! Events: this cut's `/events` WS is wired (the frontend transport connects)
//! but carries no events yet — forwarding the mock app's emitted events over the
//! WS is the follow-up. The fs round-trip the smoke proves rides optimistic UI
//! state + real disk writes, which needs no push events.
//!
//! Lives in its own workspace crate (`cargo run -p test-shim`), a sibling of
//! the app package, so none of this — nor axum, nor `tauri/test` — is
//! reachable from (or bundled with) the app.

use std::net::SocketAddr;

use axum::{
    extract::ws::{WebSocket, WebSocketUpgrade},
    extract::{Path, State},
    http::{HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use notefig::register_handlers;
use serde_json::{json, Value};
use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets, INVOKE_KEY};
use tauri::webview::InvokeRequest;
use tauri::WebviewWindowBuilder;
use tokio::sync::{mpsc, oneshot};

/// A dispatch request handed from an axum handler to the main-thread Tauri loop.
struct InvokeMsg {
    cmd: String,
    args: Value,
    /// `Ok(json)` resolves the frontend's invoke; `Err(json)` rejects it
    /// (a command that returned a real `Result::Err`).
    reply: oneshot::Sender<Result<Value, Value>>,
}

type Dispatch = mpsc::UnboundedSender<InvokeMsg>;

/// Main-thread loop: owns the `MockRuntime` app + a webview and answers dispatch
/// requests through Tauri's real IPC path. Runs until every sender is dropped.
fn run_dispatch_loop(mut rx: mpsc::UnboundedReceiver<InvokeMsg>) {
    let app = register_handlers(mock_builder())
        .build(mock_context(noop_assets()))
        .expect("failed to build shim mock app");
    let webview = WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .expect("failed to build shim webview");

    while let Some(InvokeMsg { cmd, args, reply }) = rx.blocking_recv() {
        let response = get_ipc_response(
            &webview,
            InvokeRequest {
                cmd,
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: "http://tauri.localhost".parse().unwrap(),
                body: tauri::ipc::InvokeBody::Json(args),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.to_string(),
            },
        )
        .map(|body| body.deserialize::<Value>().unwrap_or(Value::Null));
        // Receiver may have dropped if the client hung up — ignore.
        let _ = reply.send(response);
    }
}

/// `POST /invoke/{cmd}` — parse the JSON arg body (text/plain, so no CORS
/// preflight), hand it to the dispatch loop, and translate the result.
async fn invoke(
    State(tx): State<Dispatch>,
    Path(cmd): Path<String>,
    body: String,
) -> Response {
    let args: Value = if body.trim().is_empty() {
        json!({})
    } else {
        match serde_json::from_str(&body) {
            Ok(v) => v,
            Err(e) => {
                return (StatusCode::BAD_REQUEST, format!("invalid args for {cmd}: {e}"))
                    .into_response()
            }
        }
    };

    let (reply, wait) = oneshot::channel();
    if tx.send(InvokeMsg { cmd, args, reply }).is_err() {
        return (StatusCode::INTERNAL_SERVER_ERROR, "shim dispatch loop is gone").into_response();
    }
    match wait.await {
        Ok(Ok(value)) => Json(value).into_response(),
        // A command's Result::Err — reject the frontend's invoke with the value.
        Ok(Err(value)) => (StatusCode::UNPROCESSABLE_ENTITY, Json(value)).into_response(),
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, "dispatch dropped").into_response(),
    }
}

/// Event channel the frontend transport connects to (no events forwarded yet —
/// see the module note); drained until close so the connection stays healthy.
async fn events(ws: WebSocketUpgrade) -> Response {
    ws.on_upgrade(|mut socket: WebSocket| async move {
        while let Some(Ok(_)) = socket.recv().await {}
    })
}

/// Permissive CORS on every response (the UI runs on the Vite dev-server
/// origin). With text/plain request bodies this avoids preflight entirely.
async fn add_cors(response: Response) -> Response {
    let mut response = response;
    response
        .headers_mut()
        .insert("access-control-allow-origin", HeaderValue::from_static("*"));
    response
}

async fn serve(port: u16, tx: Dispatch) {
    let app = Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/invoke/:cmd", post(invoke))
        .route("/events", get(events))
        .layer(axum::middleware::map_response(add_cors))
        .with_state(tx);

    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("shim failed to bind");
    eprintln!("[test-shim] listening on http://{addr}");
    axum::serve(listener, app).await.expect("shim server error");
}

fn main() {
    // Args: `test-shim --port <n>`. Workspace paths arrive absolute per request.
    let args: Vec<String> = std::env::args().collect();
    let port: u16 = args
        .iter()
        .position(|a| a == "--port")
        .and_then(|i| args.get(i + 1))
        .and_then(|s| s.parse().ok())
        .unwrap_or(4599);

    // Keep the SQLite database out of the real app-data dir, and start empty so
    // a durability assertion cannot pass on the last run's rows. Per-port so
    // parallel shims don't share a file.
    let db_dir = std::env::temp_dir().join(format!("notefig-shim-db-{port}"));
    let _ = std::fs::remove_dir_all(&db_dir);
    std::fs::create_dir_all(&db_dir).expect("shim failed to create its db dir");
    std::env::set_var("NOTEFIG_DB_DIR", &db_dir);

    let (tx, rx) = mpsc::unbounded_channel::<InvokeMsg>();

    // axum on a worker thread with its own runtime; the Tauri app stays on the
    // main thread (safest — it is not Send and Tauri prefers the main thread).
    std::thread::spawn(move || {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("failed to build tokio runtime");
        runtime.block_on(serve(port, tx));
    });

    run_dispatch_loop(rx);
}
