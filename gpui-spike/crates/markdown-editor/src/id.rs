use std::num::NonZeroU64;
use std::sync::atomic::{AtomicU64, Ordering};

/// Opaque, process-unique block identity (design D1).
///
/// Allocated from a global counter like `dock::layout::tree::next_node_id`
/// and never reused, so an id from a removed block, another document, or a
/// state from before `set_source` can only fail lookup; it can never alias a
/// live block.
#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Debug)]
pub struct BlockId(NonZeroU64);

static NEXT_BLOCK_ID: AtomicU64 = AtomicU64::new(1);

impl BlockId {
    pub(crate) fn next() -> Self {
        let raw = NEXT_BLOCK_ID.fetch_add(1, Ordering::Relaxed);
        // The counter starts at 1 and would need 2^64 allocations to wrap.
        Self(NonZeroU64::new(raw).unwrap_or(NonZeroU64::MIN))
    }

    /// The raw value, for debugging and logging only.
    pub fn as_u64(self) -> u64 {
        self.0.get()
    }
}

/// A hasher for `BlockId` keys: ids are counter values, so a multiplicative
/// mix is enough and much cheaper than SipHash on hot per-keystroke paths.
#[derive(Default, Clone, Copy)]
pub(crate) struct IdHasher(u64);

impl std::hash::Hasher for IdHasher {
    fn finish(&self) -> u64 {
        self.0
    }
    fn write(&mut self, bytes: &[u8]) {
        for b in bytes {
            self.0 = (self.0.rotate_left(5) ^ u64::from(*b)).wrapping_mul(0x51_7c_c1_b7_27_22_0a_95);
        }
    }
    fn write_u64(&mut self, n: u64) {
        self.0 = (self.0.rotate_left(5) ^ n).wrapping_mul(0x51_7c_c1_b7_27_22_0a_95);
    }
}

pub(crate) type IdBuild = std::hash::BuildHasherDefault<IdHasher>;
/// A map keyed by `BlockId` with the cheap hasher.
pub(crate) type IdMap<V> = std::collections::HashMap<BlockId, V, IdBuild>;
