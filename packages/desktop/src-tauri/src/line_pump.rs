//! Batched line pump shared by the two line-streaming bridges
//! (`agent_proc.rs` stdout/stderr, `mcp_bridge.rs` relay connections).
//!
//! Why batching (MET-97): every `app.emit` of a single line costs a JSON
//! serialization, a `format!` into a JS wrapper script, and one
//! `WKWebView.evaluateJavaScript` IPC hop dispatched through tao's *unbounded*
//! proxy queue (`tao/src/platform_impl/macos/event_loop.rs:81`). The producer
//! reads a pipe at hundreds of MB/s; the consumer is the macOS main runloop
//! doing one cross-process hop per message. Nothing applies backpressure, so a
//! fast agent stream grows the queue — and the core process's RSS — without
//! bound.
//!
//! The consumer's cost is dominated by *fixed per-message* overhead rather than
//! payload size, so coalescing many lines into one emit attacks the actual
//! bottleneck: it cuts message count by up to `MAX_BATCH_LINES`x while leaving
//! total bytes roughly unchanged.
//!
//! This is deliberately NOT a hard memory bound — it makes the consumer outrun
//! the producer under normal load, but a sustained flood still queues bytes. A
//! true bound needs an ack from the frontend so we can stop draining the pipe;
//! that is a protocol change, and only worth it if measurement shows batching
//! was insufficient.
//!
//! Ordering is preserved: a single task owns the reader, and lines are appended
//! to the batch in read order.

use tokio::io::{AsyncBufRead, Lines};
use tokio::time::{sleep, Duration};

/// Max lines coalesced into one emit.
const MAX_BATCH_LINES: usize = 256;

/// Max bytes coalesced into one emit. Checked *before* appending, so one
/// oversized line can exceed it — lines are never split, since each is a
/// complete JSON-RPC frame the frontend must parse whole.
const MAX_BATCH_BYTES: usize = 256 * 1024;

/// How long a partially-filled batch waits for more lines before being emitted.
/// Sub-perceptual (well under one 60Hz frame), so streaming still feels live.
const MAX_BATCH_DELAY: Duration = Duration::from_millis(8);

/// Read `lines` to EOF, invoking `emit` with a non-empty batch of lines.
///
/// A batch closes on whichever comes first: `MAX_BATCH_LINES`,
/// `MAX_BATCH_BYTES`, `MAX_BATCH_DELAY` since the batch's first line, or EOF.
/// The first line of each batch is awaited without a deadline, so an idle
/// stream costs nothing and a lone line is emitted as soon as the next poll
/// finds no follower. Any partial batch is flushed before returning, so no line
/// is lost when the stream ends.
pub async fn pump_batched<B, F>(lines: &mut Lines<B>, mut emit: F)
where
    B: AsyncBufRead + Unpin,
    F: FnMut(Vec<String>),
{
    loop {
        // Block indefinitely for the first line — an idle stream must not spin.
        let first = match lines.next_line().await {
            Ok(Some(line)) => line,
            // EOF or read error: nothing buffered, so nothing to flush.
            _ => return,
        };

        let mut bytes = first.len();
        let mut batch = vec![first];
        let mut ended = false;

        let deadline = sleep(MAX_BATCH_DELAY);
        tokio::pin!(deadline);

        while batch.len() < MAX_BATCH_LINES && bytes < MAX_BATCH_BYTES {
            tokio::select! {
                // `biased` polls the reader first, so a stream that is already
                // saturated fills to the size caps instead of being cut short
                // by a timer that is also ready. The caps still bound the loop.
                biased;
                next = lines.next_line() => match next {
                    Ok(Some(line)) => {
                        bytes += line.len();
                        batch.push(line);
                    }
                    _ => {
                        ended = true;
                        break;
                    }
                },
                _ = &mut deadline => break,
            }
        }

        emit(batch);

        if ended {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncBufReadExt, BufReader};

    /// Collect every batch the pump emits for a fixed input.
    async fn run(input: &'static str) -> Vec<Vec<String>> {
        let mut lines = BufReader::new(input.as_bytes()).lines();
        let mut batches = Vec::new();
        pump_batched(&mut lines, |batch| batches.push(batch)).await;
        batches
    }

    /// The whole point: many available lines collapse into far fewer emits.
    #[tokio::test]
    async fn coalesces_available_lines_into_one_batch() {
        let batches = run("a\nb\nc\n").await;

        assert_eq!(batches, vec![vec!["a", "b", "c"]]);
    }

    /// EOF must flush the in-progress batch — a dropped tail would silently
    /// lose the last JSON-RPC frames of a turn.
    #[tokio::test]
    async fn flushes_partial_batch_at_eof() {
        // No trailing newline: the last line only completes at EOF.
        let batches = run("a\nb").await;

        assert_eq!(batches.concat(), vec!["a", "b"]);
    }

    #[tokio::test]
    async fn emits_nothing_for_empty_input() {
        assert!(run("").await.is_empty());
    }

    /// Batches are capped by line count, and no line is lost or reordered
    /// across the split.
    #[tokio::test]
    async fn caps_batch_at_max_lines_without_losing_order() {
        let total = MAX_BATCH_LINES * 2 + 5;
        let input: String = (0..total).map(|i| format!("{i}\n")).collect();
        let input: &'static str = Box::leak(input.into_boxed_str());

        let mut lines = BufReader::new(input.as_bytes()).lines();
        let mut batches: Vec<Vec<String>> = Vec::new();
        pump_batched(&mut lines, |batch| batches.push(batch)).await;

        assert!(
            batches.iter().all(|b| b.len() <= MAX_BATCH_LINES),
            "a batch exceeded MAX_BATCH_LINES: {:?}",
            batches.iter().map(Vec::len).collect::<Vec<_>>()
        );

        let flat = batches.concat();
        let expected: Vec<String> = (0..total).map(|i| i.to_string()).collect();
        assert_eq!(flat, expected, "lines lost or reordered across batches");
    }

    /// A batch stops accumulating once it crosses the byte ceiling, so a burst
    /// of large frames can't coalesce into one enormous payload — that would
    /// make peak memory worse, which is the opposite of the goal.
    #[tokio::test]
    async fn caps_batch_at_max_bytes() {
        // Each line is ~1/4 of the byte cap, so a batch closes after ~4 lines
        // — far below MAX_BATCH_LINES, proving the byte cap is what bound it.
        let line = "x".repeat(MAX_BATCH_BYTES / 4);
        let input: String = (0..12).map(|_| format!("{line}\n")).collect();
        let input: &'static str = Box::leak(input.into_boxed_str());

        let mut lines = BufReader::new(input.as_bytes()).lines();
        let mut batches: Vec<Vec<String>> = Vec::new();
        pump_batched(&mut lines, |batch| batches.push(batch)).await;

        assert!(
            batches.iter().all(|b| b.len() < MAX_BATCH_LINES),
            "byte cap did not bound the batch"
        );
        assert_eq!(batches.concat().len(), 12, "lines lost");
    }

    /// A single line larger than the byte cap is still delivered whole —
    /// splitting it would corrupt the JSON-RPC frame.
    #[tokio::test]
    async fn oversized_single_line_is_not_split() {
        let big = "y".repeat(MAX_BATCH_BYTES * 2);
        let input: &'static str = Box::leak(format!("{big}\n").into_boxed_str());

        let batches = run(input).await;

        assert_eq!(batches.concat(), vec![big]);
    }
}
