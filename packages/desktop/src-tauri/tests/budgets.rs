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
//! The counters are process-global, so `measure` serializes on a mutex. Plain
//! `cargo test` is therefore correct — no `--test-threads=1` needed, and no way
//! to run this suite wrong by forgetting a flag.

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

/// Serializes measurements. The counters are process-global, so two tests
/// measuring at once would attribute each other's allocations and fail at
/// random. Taking this lock makes plain `cargo test` correct instead of
/// depending on `--test-threads=1`, which is invisible at the callsite and
/// silently wrong the one time someone forgets it. Poisoning is ignored: a
/// panicking budget test has already failed, and its lock must not cascade.
static MEASURE_LOCK: Mutex<()> = Mutex::new(());

/// Run `f`, returning its value and the peak live heap it added, in bytes.
///
/// Measured as a delta above the live bytes already held when called, so
/// unrelated long-lived allocations (the mock app, the tokio runtime) don't
/// count against the budget. Allocations made on worker threads *during* `f`
/// are counted deliberately — they are part of the operation's cost.
fn measure<T>(f: impl FnOnce() -> T) -> (T, usize) {
    let _guard = MEASURE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
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
    metrists::register_handlers(mock_builder())
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
fn read_files_stays_within_content_plus_one_serialization() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let app = mock_app();
    let webview = main_webview(&app);

    let mut paths = Vec::new();
    let mut source = 0usize;
    for i in 0..20 {
        let (path, len) = write_text_file(tmp.path(), &format!("doc{i}.md"), 2 * 1024 * 1024);
        paths.push(path);
        source += len;
    }

    println!("\n=== read_files ===");
    let (res, peak) = measure(|| invoke_raw(&webview, "read_files", json!({ "paths": paths })));
    assert!(res.is_ok(), "read_files should dispatch");

    assert_budget("read_files (20 x 2MB)", source, peak, READ_FILES_BUDGET);
}

/// The same request split across more, smaller files must not cost more —
/// peak should track total bytes, not file count. A per-file overhead that
/// scales with N shows up here and nowhere else.
#[test]
fn read_files_peak_tracks_bytes_not_file_count() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let app = mock_app();
    let webview = main_webview(&app);

    let total = 40 * 1024 * 1024;

    let mut few = Vec::new();
    for i in 0..8 {
        let (path, _) = write_text_file(tmp.path(), &format!("few{i}.md"), total / 8);
        few.push(path);
    }
    let mut many = Vec::new();
    for i in 0..64 {
        let (path, _) = write_text_file(tmp.path(), &format!("many{i}.md"), total / 64);
        many.push(path);
    }

    println!("\n=== read_files: peak vs file count (same total bytes) ===");
    let (_, peak_few) = measure(|| invoke_raw(&webview, "read_files", json!({ "paths": few })));
    let (_, peak_many) = measure(|| invoke_raw(&webview, "read_files", json!({ "paths": many })));

    println!(
        "  8 files  peak {:>8}\n  64 files peak {:>8}",
        mb(peak_few),
        mb(peak_many)
    );
    let growth = peak_many as f64 / peak_few as f64;
    assert!(
        growth <= 1.5,
        "8x more files for the same total bytes grew peak heap {growth:.2}x — \
         per-file overhead is scaling with file count."
    );
}

/// `read_binary_files` returns `Vec<u8>`, which serde renders as a JSON array
/// of decimal integers — 3-4 bytes of JSON per source byte, live at the same
/// time as the source. This budget encodes the *intended* wire format; see the
/// note on the constant.
#[test]
fn read_binary_files_stays_within_wire_format_budget() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let app = mock_app();
    let webview = main_webview(&app);

    let (path, source) = write_binary_file(tmp.path(), "blob.bin", 8 * 1024 * 1024);

    println!("\n=== read_binary_files ===");
    let (res, peak) = measure(|| {
        invoke_raw(&webview, "read_binary_files", json!({ "paths": [path] }))
    });
    assert!(res.is_ok(), "read_binary_files should dispatch");

    assert_budget("read_binary_files (8MB)", source, peak, READ_BINARY_BUDGET);
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

// ===========================================================================
// Budget constants — see the module docs on why these are ratios, not bytes.
// ===========================================================================

/// Measured at 3.34x. The floor is ~2x (contents + their serialization); the
/// rest is `serde_json`'s output buffer doubling as it grows — during the final
/// reallocation the old and new buffers are briefly live together. 4.0x leaves
/// room for that without room for a whole extra copy of the data.
const READ_FILES_BUDGET: f64 = 4.0;

/// Measured at 7.01x, which is the cost of today's wire format: `Vec<u8>`
/// serializes to a JSON array of decimal integers (~4 bytes of JSON per source
/// byte), live alongside the source. Deliberately generous — this budget exists
/// to stop the ratio getting *worse*, not to bless it. Switching the wire
/// format to base64 would bring the real ratio under 3x; tighten this then.
const READ_BINARY_BUDGET: f64 = 8.0;

/// What search *should* cost: the matched lines plus the serialized result set.
/// Today's code is at 2536x — see the test.
const SEARCH_BUDGET: f64 = 6.0;
