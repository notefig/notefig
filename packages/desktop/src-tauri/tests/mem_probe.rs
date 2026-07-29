//! MET-97 memory probes — diagnostic instruments, not assertions.
//!
//! These measure process RSS while driving suspect commands through the real
//! Tauri IPC dispatch (handler + serde_json serialization of the response),
//! which is where the "two concurrent copies" peak lives. They print numbers
//! for a human to read and deliberately assert almost nothing — RSS is not
//! stable enough across machines to gate CI on.
//!
//! `#[ignore]`d for that reason, and because they take ~100s. Run explicitly:
//!   cargo test --test mem_probe -- --ignored --nocapture --test-threads=1
//!
//! Findings from the first run are recorded on MET-97. In short: `read_files`
//! inflates RSS to ~+350MB for 100MB of source and then PLATEAUS (allocator
//! arena sizing, not a leak), and the tauri `Listeners::pending` queue — which
//! genuinely can never drain in this app — turned out to fill too slowly to
//! matter (+7MB after ~10GB of payload pushed).

use serde_json::{json, Value};
use std::fs;
use std::path::Path;
use tauri::test::{
    get_ipc_response, mock_builder, mock_context, noop_assets, MockRuntime, INVOKE_KEY,
};
use tauri::webview::InvokeRequest;
use tauri::{App, WebviewWindow, WebviewWindowBuilder};

fn mock_app() -> App<MockRuntime> {
    metrists::register_handlers(mock_builder())
        .build(mock_context(noop_assets()))
        .expect("failed to build mock app")
}

fn main_webview(app: &App<MockRuntime>) -> WebviewWindow<MockRuntime> {
    WebviewWindowBuilder::new(app, "main", Default::default())
        .build()
        .expect("failed to build mock webview")
}

fn invoke_json(
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

/// Current process RSS in MB, via `ps` (avoids pulling in a mach dependency).
fn rss_mb() -> u64 {
    let pid = std::process::id();
    let out = std::process::Command::new("ps")
        .args(["-o", "rss=", "-p", &pid.to_string()])
        .output()
        .expect("ps failed");
    String::from_utf8_lossy(&out.stdout)
        .trim()
        .parse::<u64>()
        .unwrap_or(0)
        / 1024
}

fn report(label: &str, baseline: u64) {
    let now = rss_mb();
    println!(
        "  {:<38} RSS {:>6} MB   (delta from baseline: {:+} MB)",
        label,
        now,
        now as i64 - baseline as i64
    );
}

/// Write a file of `mb` megabytes of text into `dir`, return its path.
fn make_text_file(dir: &Path, name: &str, mb: usize) -> String {
    let path = dir.join(name);
    let chunk = "lorem ipsum dolor sit amet consectetur adipiscing elit\n".repeat(20_000); // ~1MB
    let mut content = String::with_capacity(mb * 1_100_000);
    for _ in 0..mb {
        content.push_str(&chunk);
    }
    fs::write(&path, &content).expect("write text file");
    path.to_string_lossy().to_string()
}

/// Write a file of `mb` megabytes of binary data into `dir`, return its path.
fn make_binary_file(dir: &Path, name: &str, mb: usize) -> String {
    let path = dir.join(name);
    let data: Vec<u8> = (0..(mb * 1024 * 1024)).map(|i| (i % 251) as u8).collect();
    fs::write(&path, &data).expect("write binary file");
    path.to_string_lossy().to_string()
}

#[test]
#[ignore = "diagnostic probe: prints RSS, asserts nothing; run with --ignored"]
fn probe_read_binary_files_high_water_mark() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let dir = tmp.path();

    let app = mock_app();
    let webview = main_webview(&app);

    let baseline = rss_mb();
    println!("\n=== read_binary_files: Vec<u8> -> JSON int-array blowup ===");
    println!("  baseline                               RSS {baseline:>6} MB");

    // 20MB binary. Expectation if the theory holds: JSON int-array is ~3-4x the
    // source bytes and is live at the same time as the Vec<u8>, so a single call
    // should spike RSS far above 20MB and NOT return to baseline afterwards.
    let bin = make_binary_file(dir, "blob.bin", 20);
    report("after creating 20MB file on disk", baseline);

    for round in 1..=3 {
        let res = invoke_json(&webview, "read_binary_files", json!({ "paths": [bin] }));
        assert!(res.is_ok(), "read_binary_files should dispatch");
        drop(res);
        report(&format!("after read_binary_files round {round}"), baseline);
    }

    println!("  (RSS staying elevated after the values are dropped == high-water-mark inflation)");
}

#[test]
#[ignore = "diagnostic probe: prints RSS, asserts nothing; run with --ignored"]
fn probe_read_files_fanout_high_water_mark() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let dir = tmp.path();

    let app = mock_app();
    let webview = main_webview(&app);

    let baseline = rss_mb();
    println!("\n=== read_files: uncapped join_all fan-out ===");
    println!("  baseline                               RSS {baseline:>6} MB");

    // 20 files x 5MB = 100MB of text, all read concurrently by join_all, all
    // live at once, then serialized to a single JSON response alongside them.
    let mut paths = Vec::new();
    for i in 0..20 {
        paths.push(make_text_file(dir, &format!("doc{i}.md"), 5));
    }
    report("after creating 20x5MB files on disk", baseline);

    for round in 1..=20 {
        let res = invoke_json(&webview, "read_files", json!({ "paths": paths }));
        assert!(res.is_ok(), "read_files should dispatch");
        drop(res);
        report(&format!("after read_files round {round}"), baseline);
    }

    println!("  (plateau == allocator arena sizing; linear climb == genuine retention)");
}

/// The prime suspect: tauri 2.10.2 `Listeners::pending`.
///
/// `emit_filter` (tauri/src/event/listener.rs:196) takes `handlers.try_lock()`;
/// on contention it pushes the whole `EmitArgs` — including the full serialized
/// payload — onto `pending`. `flush_pending` has exactly ONE call site (:211),
/// gated on `maybe_pending`, which only becomes true when a *Rust-side* handler
/// fires. This app registers zero Rust-side listeners, so that queue can never
/// drain: every try_lock collision permanently leaks one payload.
///
/// This probe emits a large payload from several threads at once (mirroring the
/// real emitters: 2 tokio tasks per agent proc, one per MCP connection, plus the
/// watcher thread) and watches RSS. A linear, non-plateauing climb == the leak.
#[test]
#[ignore = "diagnostic probe: prints RSS, asserts nothing; run with --ignored"]
fn probe_tauri_pending_event_queue_leak() {
    use std::sync::Arc;
    use tauri::Emitter;

    let app = mock_app();
    let _webview = main_webview(&app);
    let handle = Arc::new(app.handle().clone());

    let baseline = rss_mb();
    println!("\n=== tauri Listeners::pending — unbounded, never drained ===");
    println!("  baseline                               RSS {baseline:>6} MB");

    // ~64KB per emit, in the shape of a real ACP stdout frame.
    let payload = "x".repeat(64 * 1024);

    for round in 1..=10 {
        let mut threads = Vec::new();
        for _ in 0..8 {
            let h = Arc::clone(&handle);
            let p = payload.clone();
            threads.push(std::thread::spawn(move || {
                for _ in 0..2_000 {
                    let _ = h.emit("agent-proc://probe/stdout", p.clone());
                }
            }));
        }
        for t in threads {
            t.join().unwrap();
        }
        report(
            &format!("after round {round} ({}k emits)", round * 16),
            baseline,
        );
    }

    println!("  16k emits x 64KB = ~1GB of payload pushed per round.");
    println!("  Memory retained here is never reclaimable — no Rust listener exists to flush it.");
}
