//! Media subsystem: capture, encode, buffer, mux, trim.

pub mod audio;
pub mod gif;
pub mod library;
pub mod recorder;

pub use library::{ClipMetadata, TrimResult};
pub use recorder::{
    CaptureEngine, ClipWriteResult, Codec, EncoderInfo, EncoderVendor, EngineState, EngineStats,
    MonitorInfo, RecorderConfig, RecorderError,
};
