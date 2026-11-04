//! `packages/shared/src/tunnel`: pairing codes, key derivation and the
//! encrypted frame protocol shared with the `notefig agent` worker
//! (normative spec: `packages/shared/src/tunnel/PROTOCOL.md`).

pub mod encoding;
pub mod frames;
pub mod pairing;
pub mod test_vectors;

pub use frames::*;
pub use pairing::*;
