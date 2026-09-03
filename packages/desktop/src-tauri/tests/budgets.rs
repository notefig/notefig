//! Allocation budgets — Tier 2 of the MET-97 benchmark strategy.
//!
//! CI cannot gate on RSS (allocator arena state, machine, and kernel all move
//! it; see tests/mem_probe.rs). It CAN gate on **peak live heap**, which a
//! counting global allocator measures exactly and deterministically.
//!
//! The discipline that keeps these from becoming churn: assert *ratios and
//! orders of magnitude*, never exact byte counts. A budget says "this operation
//! must not hold more than N times its input" — that survives dependency bumps
//! and catches the class of bug MET-97 was, which is an operation quietly
//! holding several full copies of its data at once.
//!
//! The counters are process-global, so every test holds `exclusive()` for its
//! whole body — not just its measured region, since another test writing
//! fixture files mid-measurement lands in that measurement. Plain `cargo test`
//! is therefore correct, with no `--test-threads=1` flag to forget.

use serde_json::{json, Value};
use std::alloc::{GlobalAlloc, Layout, System};
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering::Relaxed};
use std::sync::Mutex;
use tauri::test::{
    get_ipc_response, mock_builder, mock_context, noop_assets, MockRuntime, INVOKE_KEY,
};
use tauri::webview::InvokeRequest;
use tauri::{App, WebviewWindow, WebviewWindowBuilder};

// ===========================================================================
// Counting allocator
// ===========================================================================

static LIVE: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);

struct Counting;

/// Tracks live bytes and their high-water mark. `realloc`/`alloc_zeroed` are
/// deliberately NOT overridden — `GlobalAlloc`'s defaults route through
/// `alloc`/`dealloc`, so Vec growth is counted without extra bookkeeping.
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let ptr = System.alloc(layout);
        if !ptr.is_null() {
            let live = LIVE.fetch_add(layout.size(), Relaxed) + layout.size();
            PEAK.fetch_max(live, Relaxed);
        }
        ptr
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        LIVE.fetch_sub(layout.size(), Relaxed);
        System.dealloc(ptr, layout);
    }
}

#[global_allocator]
static ALLOC: Counting = Counting;

/// Serializes whole tests, not just their measured regions.
///
/// The counters are process-global, so ANY allocation on ANY thread during a
/// measurement is attributed to it. Locking only inside `measure` is not
/// enough: while one test measures, another is writing tens of MB of fixture
/// files, and that lands in the measuring test's peak. That exact mistake made
/// an earlier version of this file report identical numbers for two different
/// workloads locally while CI — with different timing — disagreed.
///
/// So every test takes this for its entire body via `exclusive()`. That makes
/// the binary effectively single-threaded, enforced in code rather than by a
/// `--test-threads=1` flag that is invisible at the callsite and silently
/// wrong the one time someone forgets it.
static EXCLUSIVE: Mutex<()> = Mutex::new(());

/// Guard held for a whole test. Poisoning is ignored: a panicking budget test
/// has already reported its own failure, and must not cascade into the rest.
#[must_use = "hold the guard for the test's whole body, not just its measurements"]
fn exclusive() -> std::sync::MutexGuard<'static, ()> {
    EXCLUSIVE.lock().unwrap_or_else(|e| e.into_inner())
}

/// Run `f`, returning its value and the peak live heap it added, in bytes.
///
/// Measured as a delta above the live bytes already held when called, so
/// unrelated long-lived allocations (the mock app, the tokio runtime) don't
/// count against the budget. Allocations made on worker threads *during* `f`
/// are counted deliberately — they are part of the operation's cost.
///
/// Callers must already hold `exclusive()`.
fn measure<T>(f: impl FnOnce() -> T) -> (T, usize) {
    debug_assert!(
        EXCLUSIVE.try_lock().is_err(),
        "measure() called without holding exclusive() — the measurement will \
         absorb other tests' allocations"
    );
    let base = LIVE.load(Relaxed);
    PEAK.store(base, Relaxed);
    let out = f();
    let peak = PEAK.load(Relaxed).saturating_sub(base);
    (out, peak)
}

fn mb(bytes: usize) -> String {
    format!("{:.1}MB", bytes as f64 / (1024.0 * 1024.0))
}

/// Assert an operation's peak live heap stays within `limit` x its input, and
/// always print the real ratio so a regression's size is visible in CI logs.
fn assert_budget(label: &str, source_bytes: usize, peak_bytes: usize, limit: f64) {
    let ratio = peak_bytes as f64 / source_bytes as f64;
    println!(
        "  {:<34} source {:>8}  peak {:>8}  ratio {:.2}x  (budget {:.1}x)",
        label,
        mb(source_bytes),
        mb(peak_bytes),
        ratio,
        limit
    );
    assert!(
        ratio <= limit,
        "{label}: peak live heap was {ratio:.2}x the source bytes, over the {limit:.1}x budget.\n\
         This operation is holding more full copies of its data than it should — \
         check for an uncapped fan-out, or a serialization whose output is live at \
         the same time as its input."
    );
}

// ===========================================================================
// Harness
// ===========================================================================

fn mock_app() -> App<MockRuntime> {
    notefig::register_handlers(mock_builder())
        .build(mock_context(noop_assets()))
        .expect("failed to build mock app")
}

fn main_webview(app: &App<MockRuntime>) -> WebviewWindow<MockRuntime> {
    WebviewWindowBuilder::new(app, "main", Default::default())
        .build()
        .expect("failed to build mock webview")
}

/// Invoke through the real IPC dispatch and stop at the **serialized** response
/// — exactly where production stops before handing the payload to the webview.
///
/// Deliberately does NOT deserialize the response back into a `serde_json::
/// Value`. Production never does that, and it is ruinously expensive to
/// measure through: every byte of a `Vec<u8>` response becomes a `Value::
/// Number` (~24 bytes), which inflated an early version of these budgets by
/// more than 10x and would have had us "fixing" a cost that does not exist.
fn invoke_raw(
    webview: &WebviewWindow<MockRuntime>,
    cmd: &str,
    args: Value,
) -> Result<tauri::ipc::InvokeResponseBody, Value> {
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
}

fn write_text_file(dir: &Path, name: &str, bytes: usize) -> (String, usize) {
    let path = dir.join(name);
    let content = "lorem ipsum dolor sit amet consectetur\n".repeat(bytes / 38);
    std::fs::write(&path, &content).expect("write text file");
    (path.to_string_lossy().to_string(), content.len())
}

fn write_binary_file(dir: &Path, name: &str, bytes: usize) -> (String, usize) {
    let path = dir.join(name);
    let data: Vec<u8> = (0..bytes).map(|i| (i % 251) as u8).collect();
    std::fs::write(&path, &data).expect("write binary file");
    (path.to_string_lossy().to_string(), data.len())
}

// ===========================================================================
// Budgets
// ===========================================================================

/// `read_files` must not hold more than the file contents plus one
/// serialization of them. A third concurrent copy — or an uncapped fan-out
/// that buffers every file before serializing — blows this.
#[test]
fn read_file_stays_within_raw_wire_budget() {
    let _exclusive = exclusive();
    let tmp = tempfile::tempdir().expect("tempdir");
    let app = mock_app();
    let webview = main_webview(&app);

    let (path, source) = write_text_file(tmp.path(), "doc.md", 8 * 1024 * 1024);

    println!("\n=== read_file ===");
    let (res, peak) = measure(|| invoke_raw(&webview, "read_file", json!({ "path": path })));
    let body = res.expect("read_file should dispatch");
    assert!(
        matches!(body, tauri::ipc::InvokeResponseBody::Raw(ref data) if data.len() == source),
        "expected a raw response of the source bytes"
    );

    assert_budget("read_file (8MB)", source, peak, READ_FILES_BUDGET);
}

/// A request spread across many small files must stay within the same budget
/// as one across few large files. `read_files` fans out with an uncapped
/// `join_all`, so a per-file overhead — a buffer, a task, a handle held for the
/// whole batch — would show up here as the file count rises at constant bytes.
///
/// Each shape is checked against the *fixed* budget rather than against each
/// other. An earlier version compared the two measurements directly and
/// asserted the ratio between them; that failed in CI while passing locally,
/// because `read_to_string`'s buffer-growth strategy varies with platform and
/// file size (Linux reads 8 large files in ~1.8x, macOS in ~3.4x, and both land
/// at ~3.4x for 64 small ones). Comparing measurements to each other imports
/// that variance into the assertion; comparing each to a ceiling does not,
/// while still catching the overhead this test exists to catch.
#[test]
fn read_file_peak_does_not_accumulate_across_invokes() {
    let _exclusive = exclusive();
    let tmp = tempfile::tempdir().expect("tempdir");
    let app = mock_app();
    let webview = main_webview(&app);

    // 16 x 2.5MB read one-by-one (how the batch surface fans out now): the
    // peak must track ONE file's budget, not the total — a response or
    // buffer held across invokes would show up here as accumulation.
    const COUNT: usize = 16;
    const EACH: usize = (40 * 1024 * 1024) / COUNT;

    let paths: Vec<String> = (0..COUNT)
        .map(|i| write_text_file(tmp.path(), &format!("n{i}.md"), EACH).0)
        .collect();

    println!("\n=== read_file: sequential invokes at constant per-file size ===");
    let (res, peak) = measure(|| {
        let mut last = None;
        for path in &paths {
            last = Some(invoke_raw(&webview, "read_file", json!({ "path": path })));
        }
        last.expect("at least one invoke")
    });
    assert!(res.is_ok(), "read_file should dispatch");

    assert_budget(
        &format!("read_file ({COUNT} sequential invokes)"),
        EACH,
        peak,
        READ_FILES_BUDGET,
    );
}

/// `read_binary_file` returns the bytes on Tauri's raw IPC channel — no JSON
/// rendering of the payload at all. The budget guards that raw wire format:
/// a regression back to a serde-serialized `Vec<u8>` (3-4 JSON bytes per
/// source byte) blows straight through it.
#[test]
fn read_binary_file_stays_within_raw_wire_budget() {
    let _exclusive = exclusive();
    let tmp = tempfile::tempdir().expect("tempdir");
    let app = mock_app();
    let webview = main_webview(&app);

    let (path, source) = write_binary_file(tmp.path(), "blob.bin", 8 * 1024 * 1024);

    println!("\n=== read_binary_file ===");
    let (res, peak) = measure(|| {
        invoke_raw(&webview, "read_binary_file", json!({ "path": path }))
    });
    let body = res.expect("read_binary_file should dispatch");
    assert!(
        matches!(body, tauri::ipc::InvokeResponseBody::Raw(ref data) if data.len() == source),
        "expected a raw response of the source bytes"
    );

    assert_budget("read_binary_file (8MB)", source, peak, READ_BINARY_BUDGET);
}

/// A search whose matches all land on one enormous line must not scale with
/// matches-per-line.
///
/// FAILS ON TODAY'S CODE — measured at 2536x (2MB source -> 5.1GB peak).
/// `search.rs:119` clones the whole matched line into every `SearchMatch`, and
/// the 1000-result cap is a count, not a byte budget: 1000 x a 2MB minified
/// line is ~2GB of clones before serialization even starts. One bundled or
/// vendored `.min.js` in a workspace is enough to OOM the app on a search, and
/// `is_binary_by_extension` (search.rs:280) does not exclude `.min.js`, `.map`,
/// or lockfiles.
///
/// `#[ignore]`d rather than deleted so the budget is recorded and the test
/// starts passing the moment it's fixed. The fix needs a product decision this
/// test can't make for itself — how to present a match on a 2MB line (truncate
/// to a window around the match? skip the line content entirely?) — so it is
/// tracked separately rather than guessed at here.
#[test]
#[ignore = "known bug: search clones the full line per match (2536x budget); needs a truncation policy — see doc comment"]
fn search_peak_does_not_scale_with_matches_per_line() {
    let _exclusive = exclusive();
    let tmp = tempfile::tempdir().expect("tempdir");
    let app = mock_app();
    let webview = main_webview(&app);

    // One 2MB line containing many matches — a minified bundle's shape.
    let line = "needle ".repeat(300_000);
    let source = line.len();
    std::fs::write(tmp.path().join("bundle.min.js"), &line).expect("write bundle");

    println!("\n=== search_content (one huge line, many matches) ===");
    let (res, peak) = measure(|| {
        invoke_raw(
            &webview,
            "search_content",
            json!({
                "directory": tmp.path().to_string_lossy(),
                "query": "needle",
                "useRegex": false,
                "caseSensitive": false,
            }),
        )
    });
    assert!(res.is_ok(), "search_content should dispatch");

    assert_budget("search_content (2MB line)", source, peak, SEARCH_BUDGET);
}

/// MET-98 repro + regression guard: stream line payloads must never ride
/// `app.emit` toward the webview — they travel the pull path.
///
/// The emit path serializes the payload (`EmitArgs`) and `format!`s it into a
/// JavaScript source string per receiving webview. For a line in the hundreds
/// of MB that multiplies into gigabytes of transient heap in the core process
/// — and the eval script it produces is what WebKit's WebContent process
/// `CRASH()`es on in `ExternalStringImpl::create` (blank window; see the
/// crash reports on MET-98). The webview death itself needs a real WKWebView,
/// so it can't be asserted here — but the amplification that produces the
/// fatal script CAN be, because `MockRuntime` runs the identical serialize +
/// format machinery with a no-op eval at the end.
///
/// This test measures both paths on the same line, same registered JS
/// listener:
///   1. the raw payload emit (what shipped before the pull design) — printed
///      as evidence, and asserted to still exhibit >2x amplification: if a
///      tauri upgrade ever makes raw emits cheap, the printed baseline and
///      this floor tell us the pull design's rationale changed;
///   2. the production path (`line_stream` pump -> doorbell ->
///      `pull_stream_lines`), which must stay within
///      [`OVERSIZED_LINE_BUDGET`] — the line itself plus one serialized
///      response copy, and crucially *independent of the eval-script
///      machinery and of line size*.
#[test]
fn oversized_agent_line_never_rides_the_eval_path() {
    use tauri::Emitter;

    let _exclusive = exclusive();

    // The mock context ships an empty ACL (and no permission manifests, so
    // `add_capability("event:default")` can't resolve either). Hand-build a
    // resolved ACL that allows `plugin:event|listen`, so the listener
    // registration below goes through the same dispatch the frontend uses.
    let mut context = mock_context(noop_assets());
    let mut resolved = tauri::utils::acl::resolved::Resolved::default();
    resolved.allowed_commands.insert(
        "plugin:event|listen".into(),
        vec![tauri::utils::acl::resolved::ResolvedCommand {
            windows: vec![glob::Pattern::new("*").expect("glob")],
            webviews: vec![glob::Pattern::new("*").expect("glob")],
            ..Default::default()
        }],
    );
    *context.runtime_authority_mut() =
        tauri::ipc::RuntimeAuthority::new(Default::default(), resolved);
    let app = notefig::register_handlers(mock_builder())
        .build(context)
        .expect("failed to build mock app");
    let webview = main_webview(&app);

    const TOPIC: &str = "agent-proc://met98-repro/stdout-lines";

    // Register a JS listener for the topic — emit_js only builds the eval
    // script for webviews that have one, exactly like the real transport's
    // `listen()` call. Without this the test would measure a no-op.
    // The URL must be the platform's LOCAL webview origin so the ACL check
    // resolves it as Local: `tauri://localhost` on macOS/Linux, but Windows
    // serves the app from `http://tauri.localhost` and only that spelling
    // matches (the mac spelling was denied on the windows CI leg).
    #[cfg(windows)]
    let local_origin = "http://tauri.localhost";
    #[cfg(not(windows))]
    let local_origin = "tauri://localhost";
    let listened = get_ipc_response(
        &webview,
        InvokeRequest {
            cmd: "plugin:event|listen".into(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            url: local_origin.parse().unwrap(),
            body: tauri::ipc::InvokeBody::Json(
                json!({ "event": TOPIC, "target": { "kind": "Any" }, "handler": 1 }),
            ),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.to_string(),
        },
    );
    if let Err(e) = &listened {
        panic!("failed to register mock JS listener: {e:?}");
    }

    // One 32MB JSON frame — the shape of a tool result embedding a file.
    // Big enough that ratios are dominated by the payload, small enough for CI.
    let line = format!(
        "{{\"jsonrpc\":\"2.0\",\"method\":\"tool_result\",\"params\":{{\"pad\":\"{}\"}}}}",
        "y".repeat(32 * 1024 * 1024)
    );
    let source = line.len();

    println!("\n=== oversized line: raw emit vs gated pull (MET-98) ===");

    // Path 1: what shipped before the gate. The batch is emitted as-is.
    let (_, raw_peak) = measure(|| {
        let _ = app.emit(TOPIC, vec![line.clone()]);
    });
    let raw_ratio = raw_peak as f64 / source as f64;
    println!(
        "  {:<34} source {:>8}  peak {:>8}  ratio {:.2}x  (repro evidence, unasserted ceiling)",
        "raw emit (pre-fix path)",
        mb(source),
        mb(raw_peak),
        raw_ratio,
    );
    assert!(
        raw_ratio > 2.0,
        "raw emit measured only {raw_ratio:.2}x — the eval-path amplification this \
         gate exists for has disappeared (tauri change?). Re-evaluate whether the \
         oversize gate is still needed before weakening it."
    );

    // Path 2: the production path since MET-98 — pump into a pull stream,
    // ring the (payload-free) doorbell, drain via the pull command. The full
    // round trip is measured: queue admission, doorbell emit, IPC dispatch,
    // and the serialized response.
    let ((), pull_peak) = measure(|| {
        let stream = notefig::line_stream::create("budget/oversized");
        tauri::async_runtime::block_on(async {
            let mut reader = tokio::io::AsyncBufReadExt::lines(line.as_bytes());
            notefig::line_stream::pump(&stream, &mut reader, || {
                // The doorbell is the ONLY thing that rides the emit/eval
                // machinery in production, so it's part of the measured cost.
                let _ = app.emit(TOPIC, ());
            })
            .await;
        });
        let pulled = invoke_raw(
            &webview,
            "pull_stream_lines",
            json!({ "streamId": "budget/oversized" }),
        );
        assert!(pulled.is_ok(), "pull_stream_lines should dispatch");
    });

    assert_budget(
        "pull path (production)",
        source,
        pull_peak,
        OVERSIZED_LINE_BUDGET,
    );
}

// ===========================================================================
// Budget constants — see the module docs on why these are ratios, not bytes.
// ===========================================================================

/// Raw wire format: the source string (its buffer moves into the response
/// via `into_bytes`, no copy) plus the raw response copy. (The old JSON
/// string wire format measured 3.34x; raw measures ~2x.)
const READ_FILES_BUDGET: f64 = 3.0;

/// The raw IPC channel: source bytes + the raw response copy, no JSON of the
/// payload. (The old `Vec<u8>`-as-JSON wire format measured 7.01x; raw
/// measures ~2x — source + one response copy — with headroom for allocator
/// noise.)
const READ_BINARY_BUDGET: f64 = 3.0;

/// What search *should* cost: the matched lines plus the serialized result set.
/// Today's code is at 2536x — see the test.
const SEARCH_BUDGET: f64 = 6.0;

/// The gated path holds the line, its parked copy's move (free), and one
/// serialized command response — ~2x floor plus reallocation headroom. The
/// raw emit path this replaces measures far above this; the point of the gate
/// is that payload size and the eval-script machinery never meet.
const OVERSIZED_LINE_BUDGET: f64 = 3.0;
