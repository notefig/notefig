//! Prefixed, time-sortable ids (port of `packages/shared/src/agent/ids.ts`).
//!
//! `prefix_` + 16 hex chars (64-bit: ms-timestamp * 4096 + per-ms counter)
//! + 10 random base62 chars. Ascending ids sort in creation order; task ids
//! are *descending* (time field bit-inverted) so any lexicographic task list
//! is newest-first.

use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

const BASE62: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

static CLOCK: Mutex<(u64, u64)> = Mutex::new((0, 0));

/// Epoch milliseconds.
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn random_base62(len: usize) -> String {
    let mut bytes = vec![0u8; len];
    if getrandom::fill(&mut bytes).is_err() {
        // Fall back to a weak but non-constant source.
        let seed = now_ms() as u64;
        for (i, b) in bytes.iter_mut().enumerate() {
            *b = (seed
                .wrapping_mul(6364136223846793005)
                .wrapping_add(i as u64)
                >> 33) as u8;
        }
    }
    bytes
        .iter()
        .map(|b| BASE62[(*b as usize) % 62] as char)
        .collect()
}

fn create(prefix: &str, descending: bool) -> String {
    let now = now_ms().max(0) as u64;
    let time = {
        let mut clock = CLOCK.lock().unwrap();
        if clock.0 != now {
            *clock = (now, 0);
        }
        clock.1 += 1;
        (now << 12).wrapping_add(clock.1)
    };
    let time = if descending { !time } else { time };
    format!("{prefix}_{time:016x}{}", random_base62(10))
}

/// Descending: newest task sorts first.
pub fn new_task_id() -> String {
    create("task", true)
}
pub fn new_turn_id() -> String {
    create("trn", false)
}
pub fn new_event_id() -> String {
    create("evt", false)
}
pub fn new_usage_bucket_id() -> String {
    create("usg", false)
}

/// 32 random bytes as hex — the MCP relay token.
pub fn random_token() -> String {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).expect("OS randomness");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Decode the creation time of an ascending id.
pub fn id_timestamp(id: &str) -> Option<i64> {
    let (_, rest) = id.split_once('_')?;
    let hex = rest.get(..16)?;
    let value = u64::from_str_radix(hex, 16).ok()?;
    Some((value >> 12) as i64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ascending_ids_sort_in_creation_order() {
        let a = new_event_id();
        let b = new_event_id();
        assert!(a < b);
        assert!(a.starts_with("evt_"));
        assert!(id_timestamp(&a).unwrap() > 0);
    }

    #[test]
    fn task_ids_sort_newest_first() {
        let a = new_task_id();
        let b = new_task_id();
        assert!(b < a);
    }
}
