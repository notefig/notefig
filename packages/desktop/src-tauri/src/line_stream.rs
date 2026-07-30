//! Pull-based line streaming shared by the two stream bridges
//! (`agent_proc.rs` stdout/stderr, `mcp_bridge.rs` relay connections).
//!
//! Why pull (MET-98, superseding MET-97's push batching): pushing payloads
//! through `app.emit` serializes them and `format!`s the result into a
//! JavaScript source string evaluated in the webview. That path has two
//! structural flaws no batching can fix: it amplifies every payload byte
//! ~6x in transient heap (measured in tests/budgets.rs), and a single
//! oversized frame produces an eval script WebKit's WebContent process
//! `CRASH()`es on (`ExternalStringImpl::create` — the MET-98 blank-window
//! crash). It also has no backpressure: a fast producer grows the tao proxy
//! queue without bound.
//!
//! Here, the reader task pushes lines into a bounded per-stream queue and
//! `emit` carries only a payload-free *doorbell*, fired when the queue turns
//! non-empty (and at end-of-stream). The frontend transport drains the queue
//! with the `pull_stream_lines` command at its own pace — command responses
//! ride the IPC response path, which never builds a JS source string, so
//! payload size stops being a webview-fatal property. When the queue is
//! full the reader stops reading; the OS pipe fills; the producer blocks on
//! write. That is real end-to-end backpressure — the same mechanism that
//! made unoptimized debug builds immune to the crash, made deliberate.
//!
//! Ordering: one task owns each reader; lines enter the queue in read order
//! and leave in queue order. A doorbell is fired under the same lock
//! discipline as the push, so the empty→non-empty transition can't be lost
//! between a final empty pull and the next push.

use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncBufRead, Lines};
use tokio::sync::Notify;

/// Queue high-water mark. Above this the reader waits for the frontend to
/// drain — bounding core-process memory per stream and letting the OS pipe
/// provide backpressure to the producer. A single line larger than this is
/// still admitted (whole lines only — each is one JSON-RPC frame), so the
/// real bound is `max(HIGH_WATER_BYTES, largest single line)` — the line
/// exists in memory regardless; what matters is that it's never multiplied.
pub const HIGH_WATER_BYTES: usize = 4 * 1024 * 1024;

/// Max bytes returned per pull (always at least one line). Bounds the IPC
/// response size while keeping round trips rare.
pub const PULL_MAX_BYTES: usize = 1024 * 1024;

#[derive(Default)]
struct StreamState {
    queue: VecDeque<String>,
    bytes: usize,
    ended: bool,
    /// Set by `remove_prefix` when the stream is abandoned (kill/stop/replace).
    /// A pump parked at the high-water mark must observe this and return, or it
    /// holds its pipe/socket open forever with the producer blocked on output.
    cancelled: bool,
}

/// One live stream: a bounded queue plus the reader's space wakeup.
pub struct LineStream {
    state: Mutex<StreamState>,
    space: Notify,
}

/// What one `pull_stream_lines` call returns.
///
/// `ended: true` means the stream is fully consumed AND its source hit EOF —
/// the entry is gone and no more doorbells will ring. An unknown stream id
/// also reports `ended: true`: the puller may race the final-drain removal,
/// and "already removed" and "just drained to end" must look the same to it.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PullResult {
    pub lines: Vec<String>,
    pub ended: bool,
}

lazy_static::lazy_static! {
    /// stream id → live stream. Sync mutex: critical sections never await.
    static ref STREAMS: Mutex<HashMap<String, Arc<LineStream>>> =
        Mutex::new(HashMap::new());
}

/// Create (or replace) the stream for `id` and register it for pulling.
/// Replacing drops the registry's handle to any stale stream with the same
/// id; a stale pump still holding its own Arc writes into an orphan that can
/// no longer be pulled, which is the same fate the process registries give
/// stale entries.
pub fn create(id: &str) -> Arc<LineStream> {
    let stream = Arc::new(LineStream {
        state: Mutex::new(StreamState::default()),
        space: Notify::new(),
    });
    STREAMS
        .lock()
        .unwrap()
        .insert(id.to_string(), stream.clone());
    stream
}

/// Drop every registered stream whose id starts with `prefix`. Used by the
/// teardown paths that know the frontend will never pull again (kill_agent,
/// stop_mcp_relay, stale replacement) so ended-but-undrained queues can't
/// accumulate.
///
/// Each dropped stream is marked cancelled and its reader woken, so a pump
/// parked at the high-water mark returns and releases its pipe/socket instead
/// of stranding the blocked producer.
pub fn remove_prefix(prefix: &str) {
    let removed: Vec<Arc<LineStream>> = {
        let mut streams = STREAMS.lock().unwrap();
        let mut removed = Vec::new();
        streams.retain(|id, stream| {
            if id.starts_with(prefix) {
                removed.push(stream.clone());
                false
            } else {
                true
            }
        });
        removed
    };
    for stream in removed {
        stream.state.lock().unwrap().cancelled = true;
        stream.space.notify_one();
    }
}

/// Read `lines` to EOF into `stream`'s queue, ringing `doorbell` on every
/// empty→non-empty transition and once at end-of-stream. Blocks (without
/// consuming the line) while the queue is at its high-water mark.
pub async fn pump<B>(stream: &LineStream, lines: &mut Lines<B>, doorbell: impl Fn())
where
    B: AsyncBufRead + Unpin,
{
    loop {
        let line = match lines.next_line().await {
            Ok(Some(line)) => line,
            // EOF or read error: mark ended and ring so the puller comes for
            // the tail (there is no empty→non-empty transition to rely on).
            _ => {
                stream.state.lock().unwrap().ended = true;
                doorbell();
                return;
            }
        };

        // Admit the line once there is room (or the queue is empty — a
        // single line may exceed the high-water mark and must still pass;
        // splitting it would corrupt the frame).
        let mut pending = Some(line);
        loop {
            enum Admit {
                RingAndBreak,
                Break,
                Cancelled,
                Wait,
            }
            let action = {
                let mut state = stream.state.lock().unwrap();
                if state.cancelled {
                    Admit::Cancelled
                } else if state.bytes < HIGH_WATER_BYTES || state.queue.is_empty() {
                    let line = pending.take().expect("line admitted twice");
                    let was_empty = state.queue.is_empty();
                    state.bytes += line.len();
                    state.queue.push_back(line);
                    if was_empty {
                        Admit::RingAndBreak
                    } else {
                        Admit::Break
                    }
                } else {
                    Admit::Wait
                }
            };
            match action {
                Admit::RingAndBreak => {
                    // Rung outside the lock; the transition itself was
                    // decided under it, so a puller that just drained to
                    // empty is guaranteed a fresh doorbell for this line.
                    doorbell();
                    break;
                }
                Admit::Break => break,
                // Abandoned mid-wait: returning drops the reader, closing the
                // pipe/socket so the blocked producer is released.
                Admit::Cancelled => return,
                Admit::Wait => stream.space.notified().await,
            }
        }
    }
}

/// Drain up to [`PULL_MAX_BYTES`] (at least one line) from a stream.
#[tauri::command]
pub fn pull_stream_lines(stream_id: String) -> PullResult {
    let stream = STREAMS.lock().unwrap().get(&stream_id).cloned();
    let Some(stream) = stream else {
        return PullResult {
            lines: Vec::new(),
            ended: true,
        };
    };

    let (result, drained) = {
        let mut state = stream.state.lock().unwrap();
        let mut lines = Vec::new();
        let mut bytes = 0usize;
        while let Some(line) = state.queue.front() {
            if !lines.is_empty() && bytes + line.len() > PULL_MAX_BYTES {
                break;
            }
            let line = state.queue.pop_front().unwrap();
            bytes += line.len();
            state.bytes -= line.len();
            lines.push(line);
        }
        let ended = state.ended && state.queue.is_empty();
        (PullResult { lines, ended }, bytes > 0)
    };

    if drained {
        // Wake a reader waiting at the high-water mark. notify_one stores a
        // permit if the reader hasn't started waiting yet, so this can't be
        // lost to the check-then-wait race.
        stream.space.notify_one();
    }
    if result.ended {
        STREAMS.lock().unwrap().remove(&stream_id);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering::Relaxed};
    use tokio::io::{AsyncBufReadExt, BufReader};

    fn drain_all(id: &str) -> (Vec<String>, bool) {
        let mut lines = Vec::new();
        loop {
            let res = pull_stream_lines(id.to_string());
            let empty = res.lines.is_empty();
            lines.extend(res.lines);
            if res.ended || empty {
                return (lines, res.ended);
            }
        }
    }

    /// Order and completeness end to end, including the EOF tail.
    #[tokio::test]
    async fn lines_come_out_in_read_order_and_end_is_reported() {
        let stream = create("t-order");
        let mut lines = BufReader::new("a\nb\nc".as_bytes()).lines();
        pump(&stream, &mut lines, || {}).await;

        let (out, ended) = drain_all("t-order");
        assert_eq!(out, vec!["a", "b", "c"]);
        assert!(ended, "EOF must surface as ended");
        // The entry is gone; a late pull reports ended idempotently.
        assert!(pull_stream_lines("t-order".into()).ended);
    }

    /// The regression guard replacing MET-97's few-emits invariant: a burst
    /// costs ONE doorbell until it is drained, plus one at end-of-stream —
    /// not one per line. Per-line doorbells would resurrect the per-message
    /// emit overhead the pull design exists to remove.
    #[tokio::test]
    async fn a_burst_of_lines_rings_the_doorbell_once_plus_end() {
        let input: String = (0..1000).map(|i| format!("{{\"id\":{i}}}\n")).collect();
        let input: &'static str = Box::leak(input.into_boxed_str());

        let stream = create("t-burst");
        let rings = AtomicUsize::new(0);
        let mut lines = BufReader::new(input.as_bytes()).lines();
        pump(&stream, &mut lines, || {
            rings.fetch_add(1, Relaxed);
        })
        .await;

        assert_eq!(
            rings.load(Relaxed),
            2,
            "expected exactly transition + end doorbells for an undrained burst"
        );
        let (out, _) = drain_all("t-burst");
        assert_eq!(out.len(), 1000, "lines lost");
    }

    /// Backpressure: the reader must stop consuming at the high-water mark
    /// and resume when the puller drains — this is the property that bounds
    /// core memory and blocks the producer via the pipe.
    #[tokio::test]
    async fn reader_waits_at_high_water_until_a_pull_drains() {
        let big = "x".repeat(HIGH_WATER_BYTES / 2);
        let input: String = (0..6).map(|_| format!("{big}\n")).collect();
        let input: &'static str = Box::leak(input.into_boxed_str());

        let stream = create("t-backpressure");
        let stream_for_pump = stream.clone();
        let pump_task = tokio::spawn(async move {
            let mut lines = BufReader::new(input.as_bytes()).lines();
            pump(&stream_for_pump, &mut lines, || {}).await;
        });

        // Give the pump time to run: it must stall at the high-water mark,
        // not buffer all 6 lines.
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        {
            let state = stream.state.lock().unwrap();
            assert!(
                !state.ended,
                "pump reached EOF without waiting — no backpressure"
            );
            assert!(
                state.bytes <= HIGH_WATER_BYTES + big.len(),
                "queue grew past high water + one line: {} bytes",
                state.bytes
            );
        }

        // Draining must wake it through to EOF.
        let (out, ended) = loop {
            let (out, ended) = drain_all("t-backpressure");
            if ended {
                break (out, ended);
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        };
        let _ = (out, ended);
        pump_task.await.expect("pump completed");
    }

    /// remove_prefix while a pump is blocked at the high-water mark must wake
    /// and end it — otherwise the reader holds its pipe/socket forever and the
    /// producer stays blocked on output (the P1 strand from PR #154 review).
    #[tokio::test]
    async fn remove_prefix_wakes_a_pump_blocked_at_high_water() {
        use tokio::io::AsyncWriteExt;

        // A duplex pipe whose write half we hold open: the pump reads real
        // newline-terminated lines but never sees EOF, so once it fills to the
        // high-water mark it parks — exactly the stranded state.
        let (mut writer, reader) = tokio::io::duplex(HIGH_WATER_BYTES * 4);
        let mut frame = vec![b'y'; HIGH_WATER_BYTES];
        frame.push(b'\n');
        // Two frames: the first is admitted (queue was empty), the second
        // parks the pump at the high-water mark.
        writer.write_all(&frame).await.unwrap();
        writer.write_all(&frame).await.unwrap();

        let stream = create("t-cancel");
        let stream_for_pump = stream.clone();
        let pump_task = tokio::spawn(async move {
            let mut lines = BufReader::new(reader).lines();
            pump(&stream_for_pump, &mut lines, || {}).await;
        });

        // Let it reach the high-water park (writer stays open → no EOF).
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        assert!(!pump_task.is_finished(), "pump should be parked, not done");

        remove_prefix("t-cancel");

        // The pump must return promptly once cancelled.
        tokio::time::timeout(std::time::Duration::from_secs(2), pump_task)
            .await
            .expect("pump did not exit after remove_prefix — strand not fixed")
            .expect("pump task panicked");
        drop(writer);
    }

    /// A single line above the high-water mark is admitted whole — splitting
    /// would corrupt the JSON-RPC frame, and the line already exists in
    /// memory; the queue must simply not multiply it.
    #[tokio::test]
    async fn one_line_larger_than_high_water_still_passes_whole() {
        let big = "y".repeat(HIGH_WATER_BYTES * 2);
        let input: &'static str = Box::leak(format!("{big}\n").into_boxed_str());

        let stream = create("t-oversize");
        let mut lines = BufReader::new(input.as_bytes()).lines();
        pump(&stream, &mut lines, || {}).await;

        let (out, ended) = drain_all("t-oversize");
        assert!(ended);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].len(), big.len());
    }

    /// Pulls respect the per-call byte cap while never returning zero lines
    /// for a non-empty queue.
    #[tokio::test]
    async fn pulls_are_capped_by_bytes_but_always_progress() {
        let line = "z".repeat(PULL_MAX_BYTES / 2);
        let input: String = (0..5).map(|_| format!("{line}\n")).collect();
        let input: &'static str = Box::leak(input.into_boxed_str());

        let stream = create("t-cap");
        let mut lines = BufReader::new(input.as_bytes()).lines();
        pump(&stream, &mut lines, || {}).await;

        let mut pulls = 0usize;
        let mut total = 0usize;
        loop {
            let res = pull_stream_lines("t-cap".into());
            assert!(
                res.lines.iter().map(String::len).sum::<usize>()
                    <= PULL_MAX_BYTES.max(res.lines.iter().map(String::len).max().unwrap_or(0)),
                "pull exceeded its byte cap"
            );
            pulls += 1;
            total += res.lines.len();
            if res.ended {
                break;
            }
            assert!(
                !res.lines.is_empty(),
                "empty pull from a non-ended stream — puller would stall"
            );
        }
        assert_eq!(total, 5, "lines lost");
        assert!(pulls >= 3, "byte cap did not chunk the drain");
    }

    /// remove_prefix drops only matching streams — the teardown paths clear
    /// their own namespace without touching other live streams.
    #[tokio::test]
    async fn remove_prefix_scopes_to_its_namespace() {
        let s1 = create("ns-a/1");
        let s2 = create("ns-b/1");
        for (stream, line) in [(&s1, "x"), (&s2, "y")] {
            let mut state = stream.state.lock().unwrap();
            state.bytes += line.len();
            state.queue.push_back(line.to_string());
        }

        remove_prefix("ns-a/");

        assert!(pull_stream_lines("ns-a/1".into()).ended, "ns-a survived removal");
        assert_eq!(pull_stream_lines("ns-b/1".into()).lines, vec!["y"]);
    }
}
