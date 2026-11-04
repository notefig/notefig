//! The speech engine: features, decoding, the bundled model, and the
//! engine that runs them (`packages/dictation/src/engine/`).

pub mod ctc;
pub mod load_model;
pub mod local_engine;
pub mod log_mel;
#[cfg(feature = "onnx")]
pub mod onnx;
