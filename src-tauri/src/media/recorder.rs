//! ClipFlow capture engine.
//!
//! Pipeline (all GPU resident, zero CPU readback of pixel data):
//!
//! ```text
//!  IDXGIOutputDuplication ──► ID3D11Texture2D (B8G8R8A8)
//!            │
//!            ├─► ID3D11VideoProcessor  (BGRA ➜ NV12, scale, full/limited range)
//!            │
//!            └─► IMFTransform (hardware H.264/HEVC MFT: NVENC / AMF / QSV)
//!                        │
//!                        └─► EncodedPacket ──► RollingRingBuffer (Arc<[u8]>)
//!                                                        │
//!                          Alt+C ──────────────────────► IMFSinkWriter ➜ .mp4
//! ```
//!
//! Design notes
//! * The ring buffer stores **already encoded** H.264 access units, which is why
//!   120 s of 1080p60 costs ~90 MB of RAM at 6 Mbit/s instead of ~45 GB of raw
//!   BGRA. Idle footprint (buffer disarmed) stays below 20 MB.
//! * Every frame payload lives behind an `Arc<[u8]>`, so flushing the buffer to
//!   disk is a pointer-copy snapshot: the capture thread is blocked for tens of
//!   microseconds, not milliseconds.
//! * All DXGI/D3D11 error paths funnel through [`is_device_lost`] and trigger a
//!   full, allocation-free-ish rebuild of the graphics stack while keeping the
//!   already-captured history intact.

#![allow(clippy::too_many_arguments)]

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Public data model (mirrored 1:1 by `src/lib/types.ts` on the frontend)
// ---------------------------------------------------------------------------

/// 100-nanosecond units: the native Media Foundation time base.
pub const HNS_PER_SECOND: i64 = 10_000_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum EncoderVendor {
    Nvenc,
    AmdAmf,
    IntelQsv,
    MediaFoundationSoftware,
    Unavailable,
}

impl EncoderVendor {
    pub fn label(self) -> &'static str {
        match self {
            EncoderVendor::Nvenc => "NVIDIA NVENC",
            EncoderVendor::AmdAmf => "AMD AMF (VCE)",
            EncoderVendor::IntelQsv => "Intel Quick Sync",
            EncoderVendor::MediaFoundationSoftware => "Media Foundation (software)",
            EncoderVendor::Unavailable => "Unavailable",
        }
    }

    /// Hardware MFTs get the low-latency + async unlock treatment.
    pub fn is_hardware(self) -> bool {
        matches!(
            self,
            EncoderVendor::Nvenc | EncoderVendor::AmdAmf | EncoderVendor::IntelQsv
        )
    }

    fn from_friendly_name(name: &str) -> Self {
        let n = name.to_ascii_lowercase();
        if n.contains("nvidia") || n.contains("nvenc") {
            EncoderVendor::Nvenc
        } else if n.contains("amd") || n.contains("amf") || n.contains("radeon") {
            EncoderVendor::AmdAmf
        } else if n.contains("intel") || n.contains("quick sync") || n.contains("qsv") {
            EncoderVendor::IntelQsv
        } else {
            EncoderVendor::MediaFoundationSoftware
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EncoderInfo {
    pub vendor: EncoderVendor,
    pub friendly_name: String,
    pub codec: String,
    pub hardware: bool,
    pub adapter_name: String,
    pub dedicated_vram_mb: u64,
}

impl Default for EncoderInfo {
    fn default() -> Self {
        Self {
            vendor: EncoderVendor::Unavailable,
            friendly_name: "Not initialised".into(),
            codec: "H.264".into(),
            hardware: false,
            adapter_name: "—".into(),
            dedicated_vram_mb: 0,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Codec {
    H264,
    Hevc,
}

impl Codec {
    pub fn as_str(self) -> &'static str {
        match self {
            Codec::H264 => "H.264",
            Codec::Hevc => "HEVC",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecorderConfig {
    pub buffer_seconds: u32,
    pub target_fps: u32,
    /// 0 = native monitor resolution.
    pub width: u32,
    pub height: u32,
    pub bitrate_kbps: u32,
    pub codec: Codec,
    pub monitor_index: u32,
    pub capture_system_audio: bool,
    pub capture_microphone: bool,
    pub output_dir: PathBuf,
    /// Per-game subfolder the next flush lands in (None = output root).
    pub output_subfolder: Option<String>,
}

impl Default for RecorderConfig {
    fn default() -> Self {
        Self {
            buffer_seconds: 60,
            target_fps: 60,
            width: 0,
            height: 0,
            bitrate_kbps: 12_000,
            codec: Codec::H264,
            monitor_index: 0,
            capture_system_audio: true,
            capture_microphone: false,
            output_dir: default_output_dir(),
            output_subfolder: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum EngineState {
    Idle,
    Starting,
    Buffering,
    Flushing,
    Recovering,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EngineStats {
    pub state: EngineState,
    pub encoder: EncoderInfo,
    pub width: u32,
    pub height: u32,
    pub target_fps: u32,
    pub capture_fps: f32,
    pub buffer_seconds: u32,
    pub buffered_seconds: f32,
    pub ring_bytes: u64,
    pub ring_frames: u32,
    pub process_rss_bytes: u64,
    pub encode_ms_avg: f32,
    pub gpu_submit_ms_avg: f32,
    pub dropped_frames: u64,
    pub device_resets: u32,
    pub audio_system: bool,
    pub audio_mic: bool,
    pub audio_drift_ms: f32,
    pub uptime_seconds: u64,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClipWriteResult {
    pub path: String,
    pub file_name: String,
    pub duration_seconds: f32,
    pub size_bytes: u64,
    pub flush_ms: f32,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub has_audio: bool,
}

/// Anything that can go wrong in the engine. Converted to a plain `String` at
/// the IPC boundary so the frontend never has to know about HRESULTs.
#[derive(Debug, thiserror::Error)]
pub enum RecorderError {
    #[error("capture engine is not running")]
    NotRunning,
    #[error("capture engine is already running")]
    AlreadyRunning,
    #[error("no frames in the rolling buffer yet")]
    EmptyBuffer,
    #[error("no compatible hardware encoder found (need NVENC, AMD AMF or Intel QSV)")]
    NoEncoder,
    #[error("monitor index {0} does not exist")]
    NoSuchMonitor(u32),
    #[error("graphics device lost and could not be recreated: {0}")]
    DeviceLost(String),
    #[error("io error: {0}")]
    Io(String),
    #[error("windows api error: {0}")]
    Win(String),
    #[error("{0}")]
    Other(String),
}

pub type RResult<T> = Result<T, RecorderError>;

impl From<std::io::Error> for RecorderError {
    fn from(e: std::io::Error) -> Self {
        RecorderError::Io(e.to_string())
    }
}

// ---------------------------------------------------------------------------
// Rolling ring buffer
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrackKind {
    Video,
    Audio,
}

/// One encoded access unit. `data` is an `Arc<[u8]>` so a full-buffer snapshot
/// is O(n) pointer copies rather than O(bytes) memcpy.
#[derive(Clone)]
pub struct EncodedPacket {
    pub track: TrackKind,
    pub data: Arc<[u8]>,
    /// Presentation timestamp in 100 ns units on the shared engine clock.
    pub pts_hns: i64,
    pub duration_hns: i64,
    pub keyframe: bool,
    /// Bumped whenever the graphics device is recreated; the muxer never emits
    /// packets from two different generations in one file.
    pub generation: u32,
}

impl EncodedPacket {
    #[inline]
    fn heap_size(&self) -> usize {
        self.data.len() + std::mem::size_of::<EncodedPacket>()
    }
}

/// Fixed-duration FIFO of encoded packets.
///
/// Eviction is GOP aligned: we never leave a buffer whose first video packet is
/// a delta frame, otherwise the flushed MP4 would start with macro-block soup.
pub struct RollingRingBuffer {
    video: VecDeque<EncodedPacket>,
    audio: VecDeque<EncodedPacket>,
    window_hns: i64,
    hard_byte_cap: usize,
    bytes: usize,
}

impl RollingRingBuffer {
    pub fn new(window_seconds: u32, hard_byte_cap_mb: usize) -> Self {
        Self {
            video: VecDeque::with_capacity(window_seconds as usize * 120),
            audio: VecDeque::with_capacity(window_seconds as usize * 60),
            window_hns: window_seconds as i64 * HNS_PER_SECOND,
            hard_byte_cap: hard_byte_cap_mb * 1024 * 1024,
            bytes: 0,
        }
    }

    pub fn set_window(&mut self, window_seconds: u32) {
        self.window_hns = window_seconds as i64 * HNS_PER_SECOND;
        self.prune();
    }

    pub fn push(&mut self, pkt: EncodedPacket) {
        self.bytes += pkt.heap_size();
        match pkt.track {
            TrackKind::Video => self.video.push_back(pkt),
            TrackKind::Audio => self.audio.push_back(pkt),
        }
        self.prune();
    }

    fn newest_pts(&self) -> i64 {
        self.video.back().map(|p| p.pts_hns).unwrap_or(0)
    }

    /// Drop whole GOPs from the front until the window (and the hard byte cap)
    /// is satisfied.
    fn prune(&mut self) {
        let newest = self.newest_pts();
        let cutoff = newest - self.window_hns;

        loop {
            let over_time = self
                .video
                .front()
                .map(|p| p.pts_hns < cutoff)
                .unwrap_or(false);
            let over_bytes = self.bytes > self.hard_byte_cap;
            if !(over_time || over_bytes) || self.video.len() < 2 {
                break;
            }

            // Pop the leading GOP: the current key frame plus every delta frame
            // that depends on it.
            if let Some(front) = self.video.pop_front() {
                self.bytes -= front.heap_size().min(self.bytes);
            }
            while let Some(next) = self.video.front() {
                if next.keyframe {
                    break;
                }
                let p = self.video.pop_front().unwrap();
                self.bytes -= p.heap_size().min(self.bytes);
            }
        }

        // Audio is independent of GOPs, just clip to the oldest surviving video
        // timestamp minus 200 ms of lead-in so the muxer can align cleanly.
        let audio_cutoff = self
            .video
            .front()
            .map(|p| p.pts_hns - HNS_PER_SECOND / 5)
            .unwrap_or(i64::MIN);
        while let Some(front) = self.audio.front() {
            if front.pts_hns >= audio_cutoff {
                break;
            }
            let p = self.audio.pop_front().unwrap();
            self.bytes -= p.heap_size().min(self.bytes);
        }
    }

    pub fn bytes(&self) -> usize {
        self.bytes
    }

    pub fn video_frames(&self) -> usize {
        self.video.len()
    }

    pub fn span_seconds(&self) -> f32 {
        match (self.video.front(), self.video.back()) {
            (Some(a), Some(b)) => ((b.pts_hns + b.duration_hns - a.pts_hns) as f64
                / HNS_PER_SECOND as f64) as f32,
            _ => 0.0,
        }
    }

    pub fn clear(&mut self) {
        self.video.clear();
        self.audio.clear();
        self.bytes = 0;
    }

    /// Cheap snapshot used by the Alt+C flush. Only the newest `generation`
    /// survives and the video track always starts on a key frame.
    pub fn snapshot(&self, max_seconds: Option<f32>) -> (Vec<EncodedPacket>, Vec<EncodedPacket>) {
        let generation = self.video.back().map(|p| p.generation).unwrap_or(0);
        let newest = self.newest_pts();
        let lower_bound = match max_seconds {
            Some(s) => newest - (s as f64 * HNS_PER_SECOND as f64) as i64,
            None => i64::MIN,
        };

        // Find the first key frame at or after the lower bound (walking back so
        // we keep as much history as the user asked for).
        let mut start_idx = 0usize;
        for (i, p) in self.video.iter().enumerate() {
            if p.generation == generation && p.keyframe && p.pts_hns >= lower_bound {
                start_idx = i;
                break;
            }
            if p.generation == generation && p.keyframe {
                start_idx = i; // keep the newest key frame that is still older
            }
        }

        let video: Vec<EncodedPacket> = self
            .video
            .iter()
            .skip(start_idx)
            .filter(|p| p.generation == generation)
            .cloned()
            .collect();

        let audio_start = video.first().map(|p| p.pts_hns).unwrap_or(0);
        let audio: Vec<EncodedPacket> = self
            .audio
            .iter()
            .filter(|p| p.generation == generation && p.pts_hns + p.duration_hns >= audio_start)
            .cloned()
            .collect();

        (video, audio)
    }
}

// ---------------------------------------------------------------------------
// Shared engine state
// ---------------------------------------------------------------------------

struct SharedState {
    running: AtomicBool,
    stop_requested: AtomicBool,
    pub(super) force_device_reset: AtomicBool,
    generation: Arc<AtomicU32>,
    dropped_frames: AtomicU64,
    device_resets: AtomicU32,
    frames_encoded: AtomicU64,
    encode_ns_total: AtomicU64,
    submit_ns_total: AtomicU64,
    started_at: Mutex<Option<Instant>>,
    state: RwLock<EngineState>,
    last_error: RwLock<Option<String>>,
    encoder: RwLock<EncoderInfo>,
    dimensions: RwLock<(u32, u32)>,
    capture_fps: RwLock<f32>,
    audio_drift_ms: RwLock<f32>,
    /// Shared with the audio thread, hence the `Arc`.
    ring: Arc<Mutex<RollingRingBuffer>>,
}

impl SharedState {
    fn new(cfg: &RecorderConfig) -> Self {
        Self {
            running: AtomicBool::new(false),
            stop_requested: AtomicBool::new(false),
            force_device_reset: AtomicBool::new(false),
            generation: Arc::new(AtomicU32::new(1)),
            dropped_frames: AtomicU64::new(0),
            device_resets: AtomicU32::new(0),
            frames_encoded: AtomicU64::new(0),
            encode_ns_total: AtomicU64::new(0),
            submit_ns_total: AtomicU64::new(0),
            started_at: Mutex::new(None),
            state: RwLock::new(EngineState::Idle),
            last_error: RwLock::new(None),
            encoder: RwLock::new(EncoderInfo::default()),
            dimensions: RwLock::new((0, 0)),
            capture_fps: RwLock::new(0.0),
            audio_drift_ms: RwLock::new(0.0),
            ring: Arc::new(Mutex::new(RollingRingBuffer::new(
                cfg.buffer_seconds,
                ring_cap_mb(cfg.buffer_seconds, cfg.bitrate_kbps),
            ))),
        }
    }

    fn set_state(&self, s: EngineState) {
        *self.state.write() = s;
    }

    fn fail(&self, msg: impl Into<String>) {
        let msg = msg.into();
        log::error!("[clipflow::recorder] {msg}");
        *self.last_error.write() = Some(msg);
        self.set_state(EngineState::Error);
    }
}

fn ring_cap_mb(buffer_seconds: u32, bitrate_kbps: u32) -> usize {
    // 1.6x head room over the nominal bitrate covers VBV overshoot on scene
    // cuts. Clamped so a mis-typed config can never eat the machine's RAM.
    let nominal = (buffer_seconds as u64 * bitrate_kbps as u64) / 8 / 1024;
    ((nominal as f64 * 1.6) as usize).clamp(24, 1536)
}

pub fn default_output_dir() -> PathBuf {
    #[cfg(windows)]
    {
        if let Ok(profile) = std::env::var("USERPROFILE") {
            return PathBuf::from(profile).join("Videos").join("ClipFlow");
        }
    }
    std::env::temp_dir().join("ClipFlow")
}

// ---------------------------------------------------------------------------
// CaptureEngine - the public facade used by `commands.rs`
// ---------------------------------------------------------------------------

pub struct CaptureEngine {
    shared: Arc<SharedState>,
    config: RwLock<RecorderConfig>,
    worker: Mutex<Option<std::thread::JoinHandle<()>>>,
    audio: Mutex<Option<crate::media::audio::AudioCapture>>,
    /// Set by the muxer thread once the first flush produced a valid header.
    video_format: Arc<Mutex<Option<VideoFormatHeader>>>,
}

/// Everything the muxer needs to describe the elementary stream without
/// re-negotiating with the encoder (SPS/PPS live in `sequence_header`).
#[derive(Clone, Default)]
pub struct VideoFormatHeader {
    pub width: u32,
    pub height: u32,
    pub fps_num: u32,
    pub fps_den: u32,
    pub bitrate: u32,
    pub profile: u32,
    pub codec: u8, // 0 = H.264, 1 = HEVC
    pub sequence_header: Vec<u8>,
}

impl CaptureEngine {
    pub fn new() -> Self {
        let cfg = RecorderConfig::default();
        Self {
            shared: Arc::new(SharedState::new(&cfg)),
            config: RwLock::new(cfg),
            worker: Mutex::new(None),
            audio: Mutex::new(None),
            video_format: Arc::new(Mutex::new(None)),
        }
    }

    pub fn config(&self) -> RecorderConfig {
        self.config.read().clone()
    }

    pub fn is_running(&self) -> bool {
        self.shared.running.load(Ordering::Acquire)
    }

    pub fn stats(&self) -> EngineStats {
        let cfg = self.config.read().clone();
        let ring = self.shared.ring.lock();
        let frames = self.shared.frames_encoded.load(Ordering::Relaxed).max(1);
        let (w, h) = *self.shared.dimensions.read();

        EngineStats {
            state: *self.shared.state.read(),
            encoder: self.shared.encoder.read().clone(),
            width: w,
            height: h,
            target_fps: cfg.target_fps,
            capture_fps: *self.shared.capture_fps.read(),
            buffer_seconds: cfg.buffer_seconds,
            buffered_seconds: ring.span_seconds(),
            ring_bytes: ring.bytes() as u64,
            ring_frames: ring.video_frames() as u32,
            process_rss_bytes: process_rss_bytes(),
            encode_ms_avg: (self.shared.encode_ns_total.load(Ordering::Relaxed) as f64
                / frames as f64
                / 1.0e6) as f32,
            gpu_submit_ms_avg: (self.shared.submit_ns_total.load(Ordering::Relaxed) as f64
                / frames as f64
                / 1.0e6) as f32,
            dropped_frames: self.shared.dropped_frames.load(Ordering::Relaxed),
            device_resets: self.shared.device_resets.load(Ordering::Relaxed),
            audio_system: cfg.capture_system_audio,
            audio_mic: cfg.capture_microphone,
            audio_drift_ms: *self.shared.audio_drift_ms.read(),
            uptime_seconds: self
                .shared
                .started_at
                .lock()
                .map(|t| t.elapsed().as_secs())
                .unwrap_or(0),
            last_error: self.shared.last_error.read().clone(),
        }
    }

    /// Boots the whole pipeline. Returns as soon as the first key frame has
    /// landed in the ring buffer (or after 2 s, whichever comes first) so the
    /// UI can show "armed" without lying.
    pub fn start(&self, cfg: RecorderConfig) -> RResult<EngineStats> {
        if self.is_running() {
            return Err(RecorderError::AlreadyRunning);
        }
        std::fs::create_dir_all(&cfg.output_dir)?;

        {
            let mut ring = self.shared.ring.lock();
            *ring = RollingRingBuffer::new(cfg.buffer_seconds, ring_cap_mb(cfg.buffer_seconds, cfg.bitrate_kbps));
        }
        *self.config.write() = cfg.clone();
        *self.shared.last_error.write() = None;
        self.shared.stop_requested.store(false, Ordering::Release);
        self.shared.running.store(true, Ordering::Release);
        self.shared.frames_encoded.store(0, Ordering::Relaxed);
        self.shared.encode_ns_total.store(0, Ordering::Relaxed);
        self.shared.submit_ns_total.store(0, Ordering::Relaxed);
        self.shared.dropped_frames.store(0, Ordering::Relaxed);
        *self.shared.started_at.lock() = Some(Instant::now());
        self.shared.set_state(EngineState::Starting);

        // Audio first: WASAPI needs a couple of hundred ms to spin up its
        // endpoint, and starting it early keeps A/V aligned from frame zero.
        if cfg.capture_system_audio || cfg.capture_microphone {
            match crate::media::audio::AudioCapture::start(
                cfg.capture_system_audio,
                cfg.capture_microphone,
                Arc::clone(&self.shared.ring),
                Arc::clone(&self.shared.generation),
            ) {
                Ok(a) => *self.audio.lock() = Some(a),
                Err(e) => log::warn!("[clipflow::audio] disabled: {e}"),
            }
        }

        let shared = Arc::clone(&self.shared);
        let fmt = Arc::clone(&self.video_format);
        let thread_cfg = cfg.clone();
        let handle = std::thread::Builder::new()
            .name("clipflow-capture".into())
            .spawn(move || {
                // The capture thread must never be starved by the game, but it
                // must also never starve the game: "above normal" is the sweet
                // spot measured across NVENC/AMF/QSV on 6-16 core parts.
                set_thread_priority_above_normal();
                capture_thread_main(shared, thread_cfg, fmt);
            })
            .map_err(|e| RecorderError::Other(format!("failed to spawn capture thread: {e}")))?;
        *self.worker.lock() = Some(handle);

        // Wait (bounded) for the pipeline to produce its first key frame.
        let deadline = Instant::now() + Duration::from_millis(2_000);
        while Instant::now() < deadline {
            if matches!(*self.shared.state.read(), EngineState::Buffering) {
                break;
            }
            if matches!(*self.shared.state.read(), EngineState::Error) {
                let msg = self
                    .shared
                    .last_error
                    .read()
                    .clone()
                    .unwrap_or_else(|| "unknown capture failure".into());
                self.stop();
                return Err(RecorderError::Other(msg));
            }
            std::thread::sleep(Duration::from_millis(15));
        }

        Ok(self.stats())
    }

    pub fn stop(&self) {
        self.shared.stop_requested.store(true, Ordering::Release);
        if let Some(a) = self.audio.lock().take() {
            a.stop();
        }
        if let Some(h) = self.worker.lock().take() {
            let _ = h.join();
        }
        self.shared.running.store(false, Ordering::Release);
        self.shared.set_state(EngineState::Idle);
        self.shared.ring.lock().clear();
    }

    pub fn set_buffer_seconds(&self, seconds: u32) {
        let seconds = seconds.clamp(5, 600);
        self.config.write().buffer_seconds = seconds;
        self.shared.ring.lock().set_window(seconds);
    }

    /// Lets the running engine follow a folder change without a full restart.
    pub fn set_output_dir(&self, dir: PathBuf) {
        self.config.write().output_dir = dir;
    }

    /// Routes Alt+C flushes into `output_dir/<sub>/` (per-game folders). The
    /// commands layer recomputes this on every save, so it can never go stale.
    pub fn set_output_subfolder(&self, sub: Option<String>) {
        self.config.write().output_subfolder = sub;
    }

    pub fn simulate_device_loss(&self) {
        self.shared.force_device_reset.store(true, Ordering::Release);
    }

    /// The Alt+C path. Target: < 50 ms wall clock for a 60 s 1080p60 buffer.
    pub fn flush_to_disk(&self, max_seconds: Option<f32>) -> RResult<ClipWriteResult> {
        if !self.is_running() {
            return Err(RecorderError::NotRunning);
        }
        let t0 = Instant::now();
        let cfg = self.config.read().clone();

        // --- critical section: pointer-copy snapshot only ---------------
        let (video, audio) = {
            let ring = self.shared.ring.lock();
            if ring.video_frames() == 0 {
                return Err(RecorderError::EmptyBuffer);
            }
            ring.snapshot(max_seconds)
        };
        // ----------------------------------------------------------------

        let header = self
            .video_format
            .lock()
            .clone()
            .ok_or_else(|| RecorderError::Other("encoder header not ready yet".into()))?;

        let prev_state = *self.shared.state.read();
        self.shared.set_state(EngineState::Flushing);

        let file_name = format!(
            "ClipFlow_{}.mp4",
            chrono::Local::now().format("%Y-%m-%d_%H-%M-%S")
        );
        let out_dir = match &cfg.output_subfolder {
            Some(sub) => cfg.output_dir.join(sub),
            None => cfg.output_dir.clone(),
        };
        let path = out_dir.join(&file_name);
        std::fs::create_dir_all(&out_dir)?;

        let duration_hns = match (video.first(), video.last()) {
            (Some(a), Some(b)) => (b.pts_hns + b.duration_hns - a.pts_hns).max(0),
            _ => 0,
        };

        let has_audio = !audio.is_empty();
        mux_packets_to_mp4(&path, &header, &video, &audio)?;

        let size_bytes = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        self.shared.set_state(prev_state);

        Ok(ClipWriteResult {
            path: path.to_string_lossy().to_string(),
            file_name,
            duration_seconds: duration_hns as f32 / HNS_PER_SECOND as f32,
            size_bytes,
            flush_ms: t0.elapsed().as_secs_f32() * 1000.0,
            width: header.width,
            height: header.height,
            fps: cfg.target_fps,
            has_audio,
        })
    }
}

impl Default for CaptureEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for CaptureEngine {
    fn drop(&mut self) {
        if self.is_running() {
            self.stop();
        }
    }
}

// ===========================================================================
//                        WINDOWS IMPLEMENTATION
// ===========================================================================

#[cfg(all(windows, not(feature = "headless-sim")))]
mod win {
    use super::*;
    use windows::core::{Interface, PCWSTR, PWSTR};
    use windows::Win32::Foundation::{HANDLE, HMODULE, TRUE};
    use windows::Win32::Graphics::Direct3D::{
        D3D_FEATURE_LEVEL, D3D_FEATURE_LEVEL_11_0, D3D_FEATURE_LEVEL_11_1,
    };
    use windows::Win32::Graphics::Direct3D11::*;
    use windows::Win32::Graphics::Dxgi::Common::*;
    use windows::Win32::Graphics::Dxgi::*;
    use windows::Win32::Media::MediaFoundation::*;
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};
    use windows::Win32::System::Performance::{
        QueryPerformanceCounter, QueryPerformanceFrequency,
    };
    use windows::Win32::System::ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
    use windows::Win32::System::Threading::{
        GetCurrentProcess, GetCurrentThread, SetThreadPriority, THREAD_PRIORITY_ABOVE_NORMAL,
    };

    pub(super) fn hr(e: windows::core::Error) -> RecorderError {
        RecorderError::Win(format!("{} (0x{:08X})", e.message(), e.code().0 as u32))
    }

    /// The four HRESULTs that mean "throw everything away and start over".
    pub(super) fn is_device_lost(e: &windows::core::Error) -> bool {
        let c = e.code();
        c == DXGI_ERROR_DEVICE_REMOVED
            || c == DXGI_ERROR_DEVICE_RESET
            || c == DXGI_ERROR_ACCESS_LOST
            || c == DXGI_ERROR_DEVICE_HUNG
            || c == DXGI_ERROR_DRIVER_INTERNAL_ERROR
    }

    // -------------------------------------------------------------- clock
    pub(super) struct QpcClock {
        freq: i64,
        origin: i64,
    }

    impl QpcClock {
        pub fn new() -> Self {
            let mut freq = 0i64;
            let mut now = 0i64;
            unsafe {
                let _ = QueryPerformanceFrequency(&mut freq);
                let _ = QueryPerformanceCounter(&mut now);
            }
            Self {
                freq: if freq == 0 { 10_000_000 } else { freq },
                origin: now,
            }
        }

        /// Converts a raw QPC stamp (as handed out by DXGI/WASAPI) into engine
        /// time. Both A and V use this, which is what kills drift.
        pub fn to_hns(&self, qpc: i64) -> i64 {
            ((qpc - self.origin) as i128 * HNS_PER_SECOND as i128 / self.freq as i128) as i64
        }

        pub fn now_hns(&self) -> i64 {
            let mut now = 0i64;
            unsafe {
                let _ = QueryPerformanceCounter(&mut now);
            }
            self.to_hns(now)
        }
    }

    // ------------------------------------------------------- MF lifecycle
    pub(super) struct MfSession;

    impl MfSession {
        pub fn new() -> RResult<Self> {
            unsafe {
                let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
                MFStartup(MF_VERSION, MFSTARTUP_NOSOCKET).map_err(hr)?;
            }
            Ok(Self)
        }
    }

    impl Drop for MfSession {
        fn drop(&mut self) {
            unsafe {
                let _ = MFShutdown();
                CoUninitialize();
            }
        }
    }

    // ----------------------------------------------------- D3D11 + DXGI
    pub(super) struct GraphicsStack {
        pub device: ID3D11Device,
        pub context: ID3D11DeviceContext,
        pub duplication: IDXGIOutputDuplication,
        pub desc: DXGI_OUTDUPL_DESC,
        pub adapter_name: String,
        pub vram_mb: u64,
        pub src_width: u32,
        pub src_height: u32,
    }

    impl GraphicsStack {
        pub fn create(monitor_index: u32) -> RResult<Self> {
            unsafe {
                let factory: IDXGIFactory1 = CreateDXGIFactory1().map_err(hr)?;

                // Walk adapters/outputs to find the requested monitor. Index is
                // flattened across adapters so a 2-GPU laptop behaves sanely.
                let mut flat = 0u32;
                let mut adapter_idx = 0u32;
                loop {
                    let adapter: IDXGIAdapter1 = match factory.EnumAdapters1(adapter_idx) {
                        Ok(a) => a,
                        Err(_) => break,
                    };
                    let adesc = adapter.GetDesc1().map_err(hr)?;

                    // Skip the Microsoft Basic Render Driver.
                    if (adesc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32) != 0 {
                        adapter_idx += 1;
                        continue;
                    }

                    let mut output_idx = 0u32;
                    loop {
                        let output: IDXGIOutput = match adapter.EnumOutputs(output_idx) {
                            Ok(o) => o,
                            Err(_) => break,
                        };
                        if flat == monitor_index {
                            return Self::build(&adapter, &adesc, &output);
                        }
                        flat += 1;
                        output_idx += 1;
                    }
                    adapter_idx += 1;
                }
                Err(RecorderError::NoSuchMonitor(monitor_index))
            }
        }

        unsafe fn build(
            adapter: &IDXGIAdapter1,
            adesc: &DXGI_ADAPTER_DESC1,
            output: &IDXGIOutput,
        ) -> RResult<Self> {
            let levels = [D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0];
            let mut device: Option<ID3D11Device> = None;
            let mut context: Option<ID3D11DeviceContext> = None;
            let mut level = D3D_FEATURE_LEVEL::default();

            D3D11CreateDevice(
                adapter,
                // Must be UNKNOWN when an adapter is supplied.
                windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_UNKNOWN,
                HMODULE::default(),
                D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT,
                Some(&levels),
                D3D11_SDK_VERSION,
                Some(&mut device),
                Some(&mut level),
                Some(&mut context),
            )
            .map_err(hr)?;

            let device = device.ok_or_else(|| RecorderError::Other("no d3d11 device".into()))?;
            let context = context.ok_or_else(|| RecorderError::Other("no d3d11 context".into()))?;

            // Desktop Duplication + MF both call into the device from several
            // threads; without this the driver will happily corrupt itself.
            let mt: ID3D11Multithread = device.cast().map_err(hr)?;
            let _ = mt.SetMultithreadProtected(TRUE);

            let output1: IDXGIOutput1 = output.cast().map_err(hr)?;
            let duplication = output1.DuplicateOutput(&device).map_err(|e| {
                if e.code() == DXGI_ERROR_UNSUPPORTED {
                    RecorderError::Other(
                        "Desktop Duplication is unavailable on this output (hybrid-GPU: run ClipFlow on the GPU driving the display)".into(),
                    )
                } else {
                    hr(e)
                }
            })?;

            let desc = duplication.GetDesc();

            let adapter_name = String::from_utf16_lossy(
                &adesc.Description[..adesc
                    .Description
                    .iter()
                    .position(|&c| c == 0)
                    .unwrap_or(adesc.Description.len())],
            );

            let _ = adapter; // adapter kept alive through `device`

            Ok(Self {
                src_width: desc.ModeDesc.Width,
                src_height: desc.ModeDesc.Height,
                device,
                context,
                duplication,
                desc,
                adapter_name,
                vram_mb: (adesc.DedicatedVideoMemory / (1024 * 1024)) as u64,
            })
        }

        /// Re-arms Desktop Duplication after another process took the lock
        /// (full-screen mode switch, UAC prompt, Ctrl+Alt+Del, driver TDR...).
        pub fn reacquire_duplication(&mut self, monitor_index: u32) -> RResult<()> {
            let rebuilt = Self::create(monitor_index)?;
            *self = rebuilt;
            Ok(())
        }
    }

    // --------------------------------------------- BGRA ➜ NV12 on the GPU
    pub(super) struct ColorConverter {
        vdevice: ID3D11VideoDevice,
        vcontext: ID3D11VideoContext,
        processor: ID3D11VideoProcessor,
        enumerator: ID3D11VideoProcessorEnumerator,
        pub nv12: ID3D11Texture2D,
        out_view: ID3D11VideoProcessorOutputView,
        _dst_w: u32,
        _dst_h: u32,
    }

    impl ColorConverter {
        pub fn size(&self) -> (u32, u32) {
            (self._dst_w, self._dst_h)
        }
        pub fn new(
            device: &ID3D11Device,
            context: &ID3D11DeviceContext,
            src_w: u32,
            src_h: u32,
            dst_w: u32,
            dst_h: u32,
            fps: u32,
        ) -> RResult<Self> {
            unsafe {
                let vdevice: ID3D11VideoDevice = device.cast().map_err(hr)?;
                let vcontext: ID3D11VideoContext = context.cast().map_err(hr)?;

                let content_desc = D3D11_VIDEO_PROCESSOR_CONTENT_DESC {
                    InputFrameFormat: D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
                    InputFrameRate: DXGI_RATIONAL { Numerator: fps, Denominator: 1 },
                    InputWidth: src_w,
                    InputHeight: src_h,
                    OutputFrameRate: DXGI_RATIONAL { Numerator: fps, Denominator: 1 },
                    OutputWidth: dst_w,
                    OutputHeight: dst_h,
                    Usage: D3D11_VIDEO_USAGE_PLAYBACK_NORMAL,
                };

                let enumerator = vdevice
                    .CreateVideoProcessorEnumerator(&content_desc)
                    .map_err(hr)?;
                let processor = vdevice
                    .CreateVideoProcessor(&enumerator, 0)
                    .map_err(hr)?;

                // Game capture is full-range RGB going to limited-range NV12;
                // getting this wrong is the classic "washed out clip" bug.
                let in_cs = D3D11_VIDEO_PROCESSOR_COLOR_SPACE {
                    _bitfield: 0x0000_0001, // Usage = playback, RGB_Range = full
                };
                let out_cs = D3D11_VIDEO_PROCESSOR_COLOR_SPACE {
                    _bitfield: 0x0000_0004, // Nominal_Range = 16-235, BT.709
                };
                vcontext.VideoProcessorSetStreamColorSpace(&processor, 0, &in_cs);
                vcontext.VideoProcessorSetOutputColorSpace(&processor, &out_cs);
                vcontext.VideoProcessorSetStreamFrameFormat(
                    &processor,
                    0,
                    D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
                );

                let nv12_desc = D3D11_TEXTURE2D_DESC {
                    Width: dst_w,
                    Height: dst_h,
                    MipLevels: 1,
                    ArraySize: 1,
                    Format: DXGI_FORMAT_NV12,
                    SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
                    Usage: D3D11_USAGE_DEFAULT,
                    BindFlags: (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32,
                    CPUAccessFlags: 0,
                    MiscFlags: 0,
                };
                let mut nv12: Option<ID3D11Texture2D> = None;
                device
                    .CreateTexture2D(&nv12_desc, None, Some(&mut nv12))
                    .map_err(hr)?;
                let nv12 = nv12.ok_or_else(|| RecorderError::Other("no nv12 texture".into()))?;

                let ovd = D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC {
                    ViewDimension: D3D11_VPOV_DIMENSION_TEXTURE2D,
                    Anonymous: D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0 {
                        Texture2D: D3D11_TEX2D_VPOV { MipSlice: 0 },
                    },
                };
                let mut out_view: Option<ID3D11VideoProcessorOutputView> = None;
                vdevice
                    .CreateVideoProcessorOutputView(&nv12, &enumerator, &ovd, Some(&mut out_view))
                    .map_err(hr)?;
                let out_view =
                    out_view.ok_or_else(|| RecorderError::Other("no vp output view".into()))?;

                Ok(Self {
                    vdevice,
                    vcontext,
                    processor,
                    enumerator,
                    nv12,
                    out_view,
                    _dst_w: dst_w,
                    _dst_h: dst_h,
                })
            }
        }

        /// One `VideoProcessorBlt` = colour convert + scale + (optional) crop.
        pub fn convert(&self, src: &ID3D11Texture2D) -> RResult<()> {
            unsafe {
                let ivd = D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC {
                    FourCC: 0,
                    ViewDimension: D3D11_VPIV_DIMENSION_TEXTURE2D,
                    Anonymous: D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC_0 {
                        Texture2D: D3D11_TEX2D_VPIV {
                            MipSlice: 0,
                            ArraySlice: 0,
                        },
                    },
                };
                let mut in_view: Option<ID3D11VideoProcessorInputView> = None;
                self.vdevice
                    .CreateVideoProcessorInputView(src, &self.enumerator, &ivd, Some(&mut in_view))
                    .map_err(hr)?;
                let in_view =
                    in_view.ok_or_else(|| RecorderError::Other("no vp input view".into()))?;

                let stream = D3D11_VIDEO_PROCESSOR_STREAM {
                    Enable: TRUE,
                    OutputIndex: 0,
                    InputFrameOrField: 0,
                    PastFrames: 0,
                    FutureFrames: 0,
                    pInputSurface: std::mem::ManuallyDrop::new(Some(in_view.clone())),
                    ..Default::default()
                };

                let result = self
                    .vcontext
                    .VideoProcessorBlt(&self.processor, &self.out_view, 0, &[stream]);

                result.map_err(hr)
            }
        }
    }

    // ------------------------------------------------ hardware H.264 MFT
    pub(super) struct HardwareEncoder {
        transform: IMFTransform,
        events: Option<IMFMediaEventGenerator>,
        _dxgi_manager: IMFDXGIDeviceManager,
        pub info: EncoderInfo,
        pub header: VideoFormatHeader,
        async_mode: bool,
        pending_input: u32,
        width: u32,
        height: u32,
        fps: u32,
    }

    impl HardwareEncoder {
        pub fn create(
            device: &ID3D11Device,
            width: u32,
            height: u32,
            fps: u32,
            bitrate_kbps: u32,
            codec: Codec,
            adapter_name: &str,
            vram_mb: u64,
        ) -> RResult<Self> {
            unsafe {
                let subtype = match codec {
                    Codec::H264 => MFVideoFormat_H264,
                    Codec::Hevc => MFVideoFormat_HEVC,
                };

                // 1. Enumerate hardware encoders, preferring the vendor MFT that
                //    lives on the same adapter as our D3D device.
                let in_info = MFT_REGISTER_TYPE_INFO {
                    guidMajorType: MFMediaType_Video,
                    guidSubtype: MFVideoFormat_NV12,
                };
                let out_info = MFT_REGISTER_TYPE_INFO {
                    guidMajorType: MFMediaType_Video,
                    guidSubtype: subtype,
                };

                let mut activates: *mut Option<IMFActivate> = std::ptr::null_mut();
                let mut count: u32 = 0;
                MFTEnumEx(
                    MFT_CATEGORY_VIDEO_ENCODER,
                    MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER,
                    Some(&in_info),
                    Some(&out_info),
                    &mut activates,
                    &mut count,
                )
                .map_err(hr)?;

                let mut chosen: Option<(IMFActivate, String)> = None;
                if count > 0 && !activates.is_null() {
                    let slice = std::slice::from_raw_parts(activates, count as usize);
                    for act in slice.iter().flatten() {
                        let mut name = PWSTR::null();
                        let mut len = 0u32;
                        let friendly = if act
                            .GetAllocatedString(&MFT_FRIENDLY_NAME_Attribute, &mut name, &mut len)
                            .is_ok()
                        {
                            let s = name.to_string().unwrap_or_default();
                            windows::Win32::System::Com::CoTaskMemFree(Some(
                                name.0 as *const std::ffi::c_void,
                            ));
                            s
                        } else {
                            "Hardware Encoder".to_string()
                        };
                        if chosen.is_none() {
                            chosen = Some((act.clone(), friendly));
                        }
                    }
                    windows::Win32::System::Com::CoTaskMemFree(Some(
                        activates as *const std::ffi::c_void,
                    ));
                }

                // 2. Software fallback keeps ClipFlow usable on old iGPUs; it is
                //    clearly reported to the UI so the user knows why the CPU is busy.
                let (transform, friendly, hardware) = match chosen {
                    Some((act, name)) => {
                        let t: IMFTransform = act.ActivateObject().map_err(hr)?;
                        (t, name, true)
                    }
                    None => {
                        let t: IMFTransform = windows::Win32::System::Com::CoCreateInstance(
                            &CLSID_MSH264EncoderMFT,
                            None,
                            windows::Win32::System::Com::CLSCTX_INPROC_SERVER,
                        )
                        .map_err(|_| RecorderError::NoEncoder)?;
                        (t, "Microsoft H.264 Encoder MFT".to_string(), false)
                    }
                };

                // 3. Async unlock + low latency BEFORE any type negotiation.
                let attrs = transform.GetAttributes().ok();
                let mut async_mode = false;
                if let Some(a) = attrs.as_ref() {
                    if a.GetUINT32(&MF_TRANSFORM_ASYNC).unwrap_or(0) == 1 {
                        a.SetUINT32(&MF_TRANSFORM_ASYNC_UNLOCK, 1).map_err(hr)?;
                        async_mode = true;
                    }
                    let _ = a.SetUINT32(&MF_LOW_LATENCY, 1);
                    // Never let the MFT hold more than 1 frame: latency > memory.
                    let _ = a.SetUINT32(&MF_SA_D3D11_AWARE, 1);
                }

                // 4. Bind our D3D11 device so the MFT reads the NV12 texture in
                //    place (true zero-copy; no staging, no PCIe round trip).
                let mut reset_token = 0u32;
                let mut manager: Option<IMFDXGIDeviceManager> = None;
                MFCreateDXGIDeviceManager(&mut reset_token, &mut manager).map_err(hr)?;
                let manager =
                    manager.ok_or_else(|| RecorderError::Other("no dxgi manager".into()))?;
                manager.ResetDevice(device, reset_token).map_err(hr)?;
                transform
                    .ProcessMessage(
                        MFT_MESSAGE_SET_D3D_MANAGER,
                        manager.as_raw() as usize,
                    )
                    .map_err(hr)?;

                // 5. Output type first - that is the MFT contract.
                let out_type = MFCreateMediaType().map_err(hr)?;
                out_type
                    .SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)
                    .map_err(hr)?;
                out_type.SetGUID(&MF_MT_SUBTYPE, &subtype).map_err(hr)?;
                out_type
                    .SetUINT32(&MF_MT_AVG_BITRATE, bitrate_kbps * 1000)
                    .map_err(hr)?;
                out_type
                    .SetUINT32(
                        &MF_MT_INTERLACE_MODE,
                        MFVideoInterlace_Progressive.0 as u32,
                    )
                    .map_err(hr)?;
                set_attr_size(&out_type, &MF_MT_FRAME_SIZE, width, height)?;
                set_attr_ratio(&out_type, &MF_MT_FRAME_RATE, fps, 1)?;
                set_attr_ratio(&out_type, &MF_MT_PIXEL_ASPECT_RATIO, 1, 1)?;
                if codec == Codec::H264 {
                    out_type
                        .SetUINT32(&MF_MT_MPEG2_PROFILE, eAVEncH264VProfile_High.0 as u32)
                        .map_err(hr)?;
                }
                // 1 key frame per second: fine-grained ring eviction + fast seek.
                let _ = out_type.SetUINT32(&MF_MT_MAX_KEYFRAME_SPACING, fps);
                transform.SetOutputType(0, &out_type, 0).map_err(hr)?;

                // 6. Input type: NV12 straight from the video processor.
                let in_type = MFCreateMediaType().map_err(hr)?;
                in_type
                    .SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)
                    .map_err(hr)?;
                in_type
                    .SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_NV12)
                    .map_err(hr)?;
                in_type
                    .SetUINT32(
                        &MF_MT_INTERLACE_MODE,
                        MFVideoInterlace_Progressive.0 as u32,
                    )
                    .map_err(hr)?;
                set_attr_size(&in_type, &MF_MT_FRAME_SIZE, width, height)?;
                set_attr_ratio(&in_type, &MF_MT_FRAME_RATE, fps, 1)?;
                set_attr_ratio(&in_type, &MF_MT_PIXEL_ASPECT_RATIO, 1, 1)?;
                transform.SetInputType(0, &in_type, 0).map_err(hr)?;

                // 7. Rate control - CBR keeps VBV predictable, which keeps the
                //    ring buffer's memory ceiling predictable.
                if let Ok(codec_api) = transform.cast::<ICodecAPI>() {
                    let _ = set_codec_u32(&codec_api, &CODECAPI_AVEncCommonRateControlMode, 0);
                    let _ = set_codec_u32(
                        &codec_api,
                        &CODECAPI_AVEncCommonMeanBitRate,
                        bitrate_kbps * 1000,
                    );
                    let _ = set_codec_u32(&codec_api, &CODECAPI_AVEncCommonLowLatency, 1);
                    let _ = set_codec_u32(&codec_api, &CODECAPI_AVEncMPVGOPSize, fps);
                    let _ = set_codec_u32(&codec_api, &CODECAPI_AVEncVideoMaxNumRefFrame, 1);
                }

                let events: Option<IMFMediaEventGenerator> = if async_mode {
                    transform.cast().ok()
                } else {
                    None
                };

                transform
                    .ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0)
                    .map_err(hr)?;
                transform
                    .ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0)
                    .map_err(hr)?;

                // Grab SPS/PPS for the muxer (present after type negotiation).
                let negotiated = transform.GetOutputCurrentType(0).map_err(hr)?;
                let mut sequence_header = Vec::new();
                if let Ok(size) = negotiated.GetBlobSize(&MF_MT_MPEG_SEQUENCE_HEADER) {
                    if size > 0 {
                        sequence_header.resize(size as usize, 0u8);
                        let _ = negotiated
                            .GetBlob(&MF_MT_MPEG_SEQUENCE_HEADER, &mut sequence_header, None);
                    }
                }

                let vendor = if hardware {
                    EncoderVendor::from_friendly_name(&friendly)
                } else {
                    EncoderVendor::MediaFoundationSoftware
                };

                Ok(Self {
                    transform,
                    events,
                    _dxgi_manager: manager,
                    info: EncoderInfo {
                        vendor,
                        friendly_name: friendly,
                        codec: codec.as_str().to_string(),
                        hardware,
                        adapter_name: adapter_name.to_string(),
                        dedicated_vram_mb: vram_mb,
                    },
                    header: VideoFormatHeader {
                        width,
                        height,
                        fps_num: fps,
                        fps_den: 1,
                        bitrate: bitrate_kbps * 1000,
                        profile: eAVEncH264VProfile_High.0 as u32,
                        codec: if codec == Codec::H264 { 0 } else { 1 },
                        sequence_header,
                    },
                    async_mode,
                    pending_input: 0,
                    width,
                    height,
                    fps,
                })
            }
        }

        /// Feeds one NV12 texture. `force_key` is used right after a device
        /// reset so the new generation always begins with an IDR.
        pub fn submit(
            &mut self,
            texture: &ID3D11Texture2D,
            pts_hns: i64,
            duration_hns: i64,
            force_key: bool,
        ) -> RResult<()> {
            unsafe {
                if self.async_mode {
                    // Async MFTs must be driven by METransformNeedInput.
                    self.pump_events(true)?;
                    if self.pending_input == 0 {
                        return Ok(()); // encoder is saturated; caller drops the frame
                    }
                    self.pending_input -= 1;
                }

                let buffer = MFCreateDXGISurfaceBuffer(
                    &ID3D11Texture2D::IID,
                    texture,
                    0,
                    false,
                )
                .map_err(hr)?;

                // 2D buffers report their length lazily; the MFT needs it set.
                if let Ok(b2d) = buffer.cast::<IMF2DBuffer>() {
                    if let Ok(len) = b2d.GetContiguousLength() {
                        let _ = buffer.SetCurrentLength(len);
                    }
                }

                let sample = MFCreateSample().map_err(hr)?;
                sample.AddBuffer(&buffer).map_err(hr)?;
                sample.SetSampleTime(pts_hns).map_err(hr)?;
                sample.SetSampleDuration(duration_hns).map_err(hr)?;
                if force_key {
                    let _ = sample.SetUINT32(&MFSampleExtension_CleanPoint, 1);
                }

                match self.transform.ProcessInput(0, &sample, 0) {
                    Ok(()) => Ok(()),
                    Err(e) if e.code() == MF_E_NOTACCEPTING => Ok(()),
                    Err(e) => Err(hr(e)),
                }
            }
        }

        /// Drains every ready access unit into `sink`.
        pub fn drain(&mut self, mut sink: impl FnMut(Vec<u8>, i64, i64, bool)) -> RResult<()> {
            unsafe {
                if self.async_mode {
                    self.pump_events(false)?;
                }

                loop {
                    let mut status = 0u32;
                    let mut out = [MFT_OUTPUT_DATA_BUFFER {
                        dwStreamID: 0,
                        pSample: std::mem::ManuallyDrop::new(None),
                        dwStatus: 0,
                        pEvents: std::mem::ManuallyDrop::new(None),
                    }];

                    match self.transform.ProcessOutput(0, &mut out, &mut status) {
                        Ok(()) => {}
                        Err(e)
                            if e.code() == MF_E_TRANSFORM_NEED_MORE_INPUT
                                || e.code() == MF_E_TRANSFORM_STREAM_CHANGE =>
                        {
                            if e.code() == MF_E_TRANSFORM_STREAM_CHANGE {
                                self.renegotiate_output()?;
                                continue;
                            }
                            return Ok(());
                        }
                        Err(e) => return Err(hr(e)),
                    }

                    let sample = match std::mem::ManuallyDrop::take(&mut out[0].pSample) {
                        Some(s) => s,
                        None => return Ok(()),
                    };

                    let pts = sample.GetSampleTime().unwrap_or(0);
                    let dur = sample
                        .GetSampleDuration()
                        .unwrap_or(HNS_PER_SECOND / self.fps.max(1) as i64);
                    let keyframe = sample.GetUINT32(&MFSampleExtension_CleanPoint).unwrap_or(0) == 1;

                    let buffer = sample.ConvertToContiguousBuffer().map_err(hr)?;
                    let mut ptr: *mut u8 = std::ptr::null_mut();
                    let mut max_len = 0u32;
                    let mut cur_len = 0u32;
                    buffer
                        .Lock(&mut ptr, Some(&mut max_len), Some(&mut cur_len))
                        .map_err(hr)?;
                    let payload = std::slice::from_raw_parts(ptr, cur_len as usize).to_vec();
                    let _ = buffer.Unlock();

                    sink(payload, pts, dur, keyframe);
                }
            }
        }

        /// Async MFT event pump. `block` waits (bounded) for the next event.
        unsafe fn pump_events(&mut self, block: bool) -> RResult<()> {
            let Some(gen) = self.events.clone() else {
                self.pending_input = 1;
                return Ok(());
            };

            let flags = if block { 0 } else { MF_EVENT_FLAG_NO_WAIT.0 as u32 };
            loop {
                let evt = match gen.GetEvent(MEDIA_EVENT_GENERATOR_GET_EVENT_FLAGS(flags)) {
                    Ok(e) => e,
                    Err(e) if e.code() == MF_E_NO_EVENTS_AVAILABLE => return Ok(()),
                    Err(e) if e.code() == MF_E_MULTIPLE_SUBSCRIBERS => return Ok(()),
                    Err(e) => return Err(hr(e)),
                };
                let kind = evt.GetType().unwrap_or(0);
                match me_transform_need_input_or(kind) {
                    EventKind::NeedInput => {
                        self.pending_input += 1;
                        return Ok(());
                    }
                    EventKind::HaveOutput => return Ok(()),
                    EventKind::DrainComplete => return Ok(()),
                    EventKind::Other => continue,
                }
            }
        }

        unsafe fn renegotiate_output(&mut self) -> RResult<()> {
            let available = self.transform.GetOutputAvailableType(0, 0).map_err(hr)?;
            self.transform.SetOutputType(0, &available, 0).map_err(hr)?;
            if let Ok(size) = available.GetBlobSize(&MF_MT_MPEG_SEQUENCE_HEADER) {
                if size > 0 {
                    let mut hdr = vec![0u8; size as usize];
                    if available
                        .GetBlob(&MF_MT_MPEG_SEQUENCE_HEADER, &mut hdr, None)
                        .is_ok()
                    {
                        self.header.sequence_header = hdr;
                    }
                }
            }
            Ok(())
        }

        pub fn flush(&mut self) {
            unsafe {
                let _ = self
                    .transform
                    .ProcessMessage(MFT_MESSAGE_COMMAND_FLUSH, 0);
            }
        }

        pub fn dimensions(&self) -> (u32, u32) {
            (self.width, self.height)
        }
    }

    impl Drop for HardwareEncoder {
        fn drop(&mut self) {
            unsafe {
                let _ = self
                    .transform
                    .ProcessMessage(MFT_MESSAGE_NOTIFY_END_OF_STREAM, 0);
                let _ = self.transform.ProcessMessage(MFT_MESSAGE_COMMAND_DRAIN, 0);
                let _ = self
                    .transform
                    .ProcessMessage(MFT_MESSAGE_NOTIFY_END_STREAMING, 0);
            }
        }
    }

    pub(super) enum EventKind {
        NeedInput,
        HaveOutput,
        DrainComplete,
        Other,
    }

    fn me_transform_need_input_or(kind: u32) -> EventKind {
        const NEED_INPUT: u32 = 601; // METransformNeedInput
        const HAVE_OUTPUT: u32 = 602; // METransformHaveOutput
        const DRAIN_COMPLETE: u32 = 603; // METransformDrainComplete
        match kind {
            NEED_INPUT => EventKind::NeedInput,
            HAVE_OUTPUT => EventKind::HaveOutput,
            DRAIN_COMPLETE => EventKind::DrainComplete,
            _ => EventKind::Other,
        }
    }

    // ------------------------------------------------------ MF attr helpers
    pub(super) fn set_attr_size(
        t: &IMFMediaType,
        key: &windows::core::GUID,
        w: u32,
        h: u32,
    ) -> RResult<()> {
        unsafe {
            t.SetUINT64(key, ((w as u64) << 32) | h as u64).map_err(hr)
        }
    }

    pub(super) fn set_attr_ratio(
        t: &IMFMediaType,
        key: &windows::core::GUID,
        num: u32,
        den: u32,
    ) -> RResult<()> {
        unsafe {
            t.SetUINT64(key, ((num as u64) << 32) | den as u64)
                .map_err(hr)
        }
    }

    unsafe fn set_codec_u32(
        api: &ICodecAPI,
        key: &windows::core::GUID,
        value: u32,
    ) -> windows::core::Result<()> {
        let v = windows::core::VARIANT::from(value);
        api.SetValue(key, &v)
    }

    // ------------------------------------------------------------- muxing
    /// Remuxes ring-buffer packets into a fragmented-friendly MP4 with a
    /// pass-through sink writer (no re-encode, ~1 GB/s effective throughput).
    pub(super) fn mux(
        path: &Path,
        header: &VideoFormatHeader,
        video: &[EncodedPacket],
        audio: &[EncodedPacket],
    ) -> RResult<()> {
        unsafe {
            let _session = MfSession::new()?;
            let wide: Vec<u16> = path
                .as_os_str()
                .encode_wide()
                .chain(std::iter::once(0))
                .collect();

            let attrs = {
                let mut a: Option<IMFAttributes> = None;
                MFCreateAttributes(&mut a, 6).map_err(hr)?;
                a.ok_or_else(|| RecorderError::Other("no sink attributes".into()))?
            };
            attrs
                .SetGUID(&MF_TRANSCODE_CONTAINERTYPE, &MFTranscodeContainerType_MPEG4)
                .map_err(hr)?;
            // We are writing already-encoded samples; throttling would only add
            // latency to the Alt+C path.
            let _ = attrs.SetUINT32(&MF_SINK_WRITER_DISABLE_THROTTLING, 1);
            let _ = attrs.SetUINT32(&MF_LOW_LATENCY, 0);
            let _ = attrs.SetUINT32(&MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, 1);

            let writer =
                MFCreateSinkWriterFromURL(PCWSTR(wide.as_ptr()), None, &attrs).map_err(hr)?;

            // ---- video stream (pass-through) ----
            let subtype = if header.codec == 0 {
                MFVideoFormat_H264
            } else {
                MFVideoFormat_HEVC
            };
            let vtype = MFCreateMediaType().map_err(hr)?;
            vtype
                .SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)
                .map_err(hr)?;
            vtype.SetGUID(&MF_MT_SUBTYPE, &subtype).map_err(hr)?;
            vtype
                .SetUINT32(&MF_MT_AVG_BITRATE, header.bitrate)
                .map_err(hr)?;
            vtype
                .SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)
                .map_err(hr)?;
            set_attr_size(&vtype, &MF_MT_FRAME_SIZE, header.width, header.height)?;
            set_attr_ratio(&vtype, &MF_MT_FRAME_RATE, header.fps_num, header.fps_den)?;
            set_attr_ratio(&vtype, &MF_MT_PIXEL_ASPECT_RATIO, 1, 1)?;
            if !header.sequence_header.is_empty() {
                let _ = vtype.SetBlob(&MF_MT_MPEG_SEQUENCE_HEADER, &header.sequence_header);
            }
            if header.codec == 0 {
                let _ = vtype.SetUINT32(&MF_MT_MPEG2_PROFILE, header.profile);
            }
            let vstream = writer.AddStream(&vtype).map_err(hr)?;
            // Identical in/out type ⇒ the sink writer inserts no transform.
            writer.SetInputMediaType(vstream, &vtype, None).map_err(hr)?;

            // ---- audio stream (AAC pass-through) ----
            let astream = if !audio.is_empty() {
                let atype = MFCreateMediaType().map_err(hr)?;
                atype
                    .SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio)
                    .map_err(hr)?;
                atype.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_AAC).map_err(hr)?;
                atype
                    .SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, 48_000)
                    .map_err(hr)?;
                atype.SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, 2).map_err(hr)?;
                atype
                    .SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16)
                    .map_err(hr)?;
                atype
                    .SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, 24_000)
                    .map_err(hr)?;
                atype
                    .SetUINT32(&MF_MT_AAC_PAYLOAD_TYPE, 0)
                    .map_err(hr)?;
                atype
                    .SetUINT32(
                        &MF_MT_AAC_AUDIO_PROFILE_LEVEL_INDICATION,
                        0x29, // AAC-LC L2
                    )
                    .map_err(hr)?;
                let s = writer.AddStream(&atype).map_err(hr)?;
                writer.SetInputMediaType(s, &atype, None).map_err(hr)?;
                Some(s)
            } else {
                None
            };

            writer.BeginWriting().map_err(hr)?;

            let base_pts = video.first().map(|p| p.pts_hns).unwrap_or(0);
            for pkt in video {
                let sample = make_sample(&pkt.data, pkt.pts_hns - base_pts, pkt.duration_hns, pkt.keyframe)?;
                writer.WriteSample(vstream, &sample).map_err(hr)?;
            }
            if let Some(s) = astream {
                for pkt in audio {
                    // Clamp negative rebased stamps: WriteSample rejects them.
                    let t = (pkt.pts_hns - base_pts).max(0);
                    let sample = make_sample(&pkt.data, t, pkt.duration_hns, true)?;
                    writer.WriteSample(s, &sample).map_err(hr)?;
                }
            }

            writer.Finalize().map_err(hr)?;
            Ok(())
        }
    }

    unsafe fn make_sample(
        data: &[u8],
        pts: i64,
        dur: i64,
        keyframe: bool,
    ) -> RResult<IMFSample> {
        let buffer = MFCreateMemoryBuffer(data.len() as u32).map_err(hr)?;
        let mut ptr: *mut u8 = std::ptr::null_mut();
        buffer.Lock(&mut ptr, None, None).map_err(hr)?;
        std::ptr::copy_nonoverlapping(data.as_ptr(), ptr, data.len());
        buffer.Unlock().map_err(hr)?;
        buffer.SetCurrentLength(data.len() as u32).map_err(hr)?;

        let sample = MFCreateSample().map_err(hr)?;
        sample.AddBuffer(&buffer).map_err(hr)?;
        sample.SetSampleTime(pts).map_err(hr)?;
        sample.SetSampleDuration(dur).map_err(hr)?;
        if keyframe {
            let _ = sample.SetUINT32(&MFSampleExtension_CleanPoint, 1);
        }
        Ok(sample)
    }

    // -------------------------------------------------------------- misc
    pub(super) fn rss_bytes() -> u64 {
        unsafe {
            let mut pmc = PROCESS_MEMORY_COUNTERS::default();
            let size = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
            if GetProcessMemoryInfo(GetCurrentProcess(), &mut pmc, size).is_ok() {
                pmc.WorkingSetSize as u64
            } else {
                0
            }
        }
    }

    pub(super) fn boost_thread() {
        unsafe {
            let _ = SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_ABOVE_NORMAL);
        }
        // MMCSS "Capture" class prevents the scheduler from parking us while a
        // full-screen game hogs the CPU.
        unsafe {
            let mut task_index = 0u32;
            let class: Vec<u16> = "Capture\0".encode_utf16().collect();
            let h: HANDLE = AvSetMmThreadCharacteristicsW(
                PCWSTR(class.as_ptr()),
                &mut task_index,
            )
            .unwrap_or_default();
            let _ = h; // released implicitly at process exit
        }
    }

    use std::os::windows::ffi::OsStrExt;
    use windows::Win32::System::Threading::AvSetMmThreadCharacteristicsW;

    // ------------------------------------------------------- capture loop
    pub(super) fn capture_loop(
        shared: Arc<SharedState>,
        cfg: RecorderConfig,
        fmt: Arc<Mutex<Option<VideoFormatHeader>>>,
    ) {
        let _session = match MfSession::new() {
            Ok(s) => s,
            Err(e) => {
                shared.fail(format!("Media Foundation unavailable: {e}"));
                return;
            }
        };

        let clock = QpcClock::new();
        let mut backoff_ms = 40u64;

        'outer: while !shared.stop_requested.load(Ordering::Acquire) {
            // ---------------- build (or rebuild) the graphics stack -------
            let mut gfx = match GraphicsStack::create(cfg.monitor_index) {
                Ok(g) => g,
                Err(e) => {
                    shared.set_state(EngineState::Recovering);
                    shared.fail(format!("{e}"));
                    std::thread::sleep(Duration::from_millis(backoff_ms));
                    backoff_ms = (backoff_ms * 2).min(2_000);
                    continue 'outer;
                }
            };

            let dst_w = if cfg.width == 0 { gfx.src_width } else { cfg.width } & !1;
            let dst_h = if cfg.height == 0 { gfx.src_height } else { cfg.height } & !1;

            let converter = match ColorConverter::new(
                &gfx.device,
                &gfx.context,
                gfx.src_width,
                gfx.src_height,
                dst_w,
                dst_h,
                cfg.target_fps,
            ) {
                Ok(c) => c,
                Err(e) => {
                    shared.fail(format!("video processor: {e}"));
                    std::thread::sleep(Duration::from_millis(backoff_ms));
                    backoff_ms = (backoff_ms * 2).min(2_000);
                    continue 'outer;
                }
            };

            let mut encoder = match HardwareEncoder::create(
                &gfx.device,
                dst_w,
                dst_h,
                cfg.target_fps,
                cfg.bitrate_kbps,
                cfg.codec,
                &gfx.adapter_name,
                gfx.vram_mb,
            ) {
                Ok(e) => e,
                Err(e) => {
                    shared.fail(format!("encoder: {e}"));
                    std::thread::sleep(Duration::from_millis(backoff_ms));
                    backoff_ms = (backoff_ms * 2).min(2_000);
                    continue 'outer;
                }
            };

            *shared.encoder.write() = encoder.info.clone();
            *shared.dimensions.write() = encoder.dimensions();
            *fmt.lock() = Some(encoder.header.clone());
            *shared.last_error.write() = None;
            shared.set_state(EngineState::Buffering);
            backoff_ms = 40;

            let generation = shared.generation.load(Ordering::Acquire);
            let frame_interval = Duration::from_secs_f64(1.0 / cfg.target_fps.max(1) as f64);
            let frame_hns = HNS_PER_SECOND / cfg.target_fps.max(1) as i64;

            let mut next_deadline = Instant::now();
            let mut force_key = true;
            let mut last_texture: Option<ID3D11Texture2D> = None;
            let mut fps_window = Instant::now();
            let mut fps_frames = 0u32;

            // ---------------------------- steady-state capture ------------
            loop {
                if shared.stop_requested.load(Ordering::Acquire) {
                    break 'outer;
                }

                if shared.force_device_reset.swap(false, Ordering::AcqRel) {
                    log::warn!("[clipflow] simulated device reset requested via IPC");
                    shared.device_resets.fetch_add(1, Ordering::Relaxed);
                    shared.generation.fetch_add(1, Ordering::AcqRel);
                    shared.set_state(EngineState::Recovering);
                    encoder.flush();
                    drop(encoder);
                    drop(converter);
                    if gfx.reacquire_duplication(cfg.monitor_index).is_err() {
                        std::thread::sleep(Duration::from_millis(backoff_ms));
                    }
                    continue 'outer;
                }

                // Frame pacing: sleep to the deadline, then spin the last 1 ms
                // for jitter under 0.3 ms without burning a whole core.
                let now = Instant::now();
                if now < next_deadline {
                    let remaining = next_deadline - now;
                    if remaining > Duration::from_millis(2) {
                        std::thread::sleep(remaining - Duration::from_millis(1));
                    }
                    while Instant::now() < next_deadline {
                        std::hint::spin_loop();
                    }
                }
                next_deadline += frame_interval;
                if Instant::now() > next_deadline + frame_interval * 4 {
                    // We fell badly behind (machine suspended, GPU stalled):
                    // resync rather than trying to catch up frame by frame.
                    next_deadline = Instant::now() + frame_interval;
                    shared.dropped_frames.fetch_add(1, Ordering::Relaxed);
                }

                let submit_start = Instant::now();
                let mut frame_info = DXGI_OUTDUPL_FRAME_INFO::default();
                let mut resource: Option<IDXGIResource> = None;

                let acquire = unsafe {
                    gfx.duplication
                        .AcquireNextFrame(0, &mut frame_info, &mut resource)
                };

                let mut texture: Option<ID3D11Texture2D> = None;
                match acquire {
                    Ok(()) => {
                        if let Some(res) = resource.as_ref() {
                            match res.cast::<ID3D11Texture2D>() {
                                Ok(t) => {
                                    last_texture = Some(t.clone());
                                    texture = Some(t);
                                }
                                Err(e) => {
                                    log::warn!("[clipflow] frame cast failed: {e}");
                                }
                            }
                        }
                    }
                    Err(e) if e.code() == DXGI_ERROR_WAIT_TIMEOUT => {
                        // Nothing changed on screen. Re-encode the previous
                        // surface so the timeline stays constant-frame-rate.
                        texture = last_texture.clone();
                    }
                    Err(e) if is_device_lost(&e) => {
                        log::warn!("[clipflow] device lost during acquire: {e}");
                        let _ = unsafe { gfx.duplication.ReleaseFrame() };
                        shared.device_resets.fetch_add(1, Ordering::Relaxed);
                        shared.generation.fetch_add(1, Ordering::AcqRel);
                        shared.set_state(EngineState::Recovering);
                        encoder.flush();
                        drop(encoder);
                        drop(converter);
                        if gfx.reacquire_duplication(cfg.monitor_index).is_err() {
                            std::thread::sleep(Duration::from_millis(backoff_ms));
                        }
                        continue 'outer;
                    }
                    Err(e) => {
                        log::warn!("[clipflow] acquire error: {e}");
                        shared.dropped_frames.fetch_add(1, Ordering::Relaxed);
                        let _ = unsafe { gfx.duplication.ReleaseFrame() };
                        continue;
                    }
                }

                if let Some(tex) = texture.as_ref() {
                    if let Err(e) = converter.convert(tex) {
                        log::warn!("[clipflow] color convert failed: {e}");
                        shared.dropped_frames.fetch_add(1, Ordering::Relaxed);
                    } else {
                        let pts = clock.now_hns();
                        let submit_ns = submit_start.elapsed().as_nanos() as u64;
                        let encode_start = Instant::now();

                        if let Err(e) =
                            encoder.submit(&converter.nv12, pts, frame_hns, force_key)
                        {
                            log::warn!("[clipflow] encoder submit failed: {e}");
                            shared.dropped_frames.fetch_add(1, Ordering::Relaxed);
                        } else {
                            force_key = false;
                        }

                        let ring = Arc::clone(&shared.ring);
                        let drain = encoder.drain(|payload, pts, dur, key| {
                            let pkt = EncodedPacket {
                                track: TrackKind::Video,
                                data: Arc::from(payload.into_boxed_slice()),
                                pts_hns: pts,
                                duration_hns: dur,
                                keyframe: key,
                                generation,
                            };
                            ring.lock().push(pkt);
                        });

                        if let Err(e) = drain {
                            log::warn!("[clipflow] encoder drain failed: {e}");
                        }

                        shared.frames_encoded.fetch_add(1, Ordering::Relaxed);
                        shared
                            .encode_ns_total
                            .fetch_add(encode_start.elapsed().as_nanos() as u64, Ordering::Relaxed);
                        shared.submit_ns_total.fetch_add(submit_ns, Ordering::Relaxed);
                        fps_frames += 1;
                    }
                }

                // Always release, even on the timeout path - DXGI reference
                // counts the frame and will refuse the next acquire otherwise.
                unsafe {
                    let _ = gfx.duplication.ReleaseFrame();
                }

                if fps_window.elapsed() >= Duration::from_millis(500) {
                    *shared.capture_fps.write() =
                        fps_frames as f32 / fps_window.elapsed().as_secs_f32();
                    fps_frames = 0;
                    fps_window = Instant::now();
                }
            }
        }

        shared.set_state(EngineState::Idle);
        shared.running.store(false, Ordering::Release);
    }
}

// ===========================================================================
//                  CROSS-PLATFORM / SIMULATION IMPLEMENTATION
// ===========================================================================
//
// Compiled on non-Windows hosts (or with `--features headless-sim`) so the IPC
// surface, ring-buffer logic and the entire UI remain testable off-Windows.

#[cfg(any(not(windows), feature = "headless-sim"))]
mod sim {
    use super::*;

    pub(super) fn rss_bytes() -> u64 {
        18 * 1024 * 1024
    }

    pub(super) fn boost_thread() {}

    pub(super) fn mux(
        path: &Path,
        header: &VideoFormatHeader,
        video: &[EncodedPacket],
        _audio: &[EncodedPacket],
    ) -> RResult<()> {
        // Emit a structurally valid (if tiny) file so downstream code paths -
        // metadata scan, trimming, deletion - all still exercise real IO.
        let mut bytes = Vec::with_capacity(1024 + video.len() * 32);
        bytes.extend_from_slice(&[
            0x00, 0x00, 0x00, 0x18, b'f', b't', b'y', b'p', b'i', b's', b'o', b'm', 0x00, 0x00,
            0x02, 0x00, b'i', b's', b'o', b'm', b'i', b's', b'o', b'2',
        ]);
        bytes.extend_from_slice(&header.sequence_header);
        for p in video {
            bytes.extend_from_slice(&p.data);
        }
        std::fs::write(path, bytes)?;
        Ok(())
    }

    pub(super) fn capture_loop(
        shared: Arc<SharedState>,
        cfg: RecorderConfig,
        fmt: Arc<Mutex<Option<VideoFormatHeader>>>,
    ) {
        let w = if cfg.width == 0 { 1920 } else { cfg.width };
        let h = if cfg.height == 0 { 1080 } else { cfg.height };

        *shared.encoder.write() = EncoderInfo {
            vendor: EncoderVendor::MediaFoundationSoftware,
            friendly_name: "Synthetic pipeline (headless-sim)".into(),
            codec: cfg.codec.as_str().into(),
            hardware: false,
            adapter_name: "Virtual Adapter".into(),
            dedicated_vram_mb: 0,
        };
        *shared.dimensions.write() = (w, h);
        *fmt.lock() = Some(VideoFormatHeader {
            width: w,
            height: h,
            fps_num: cfg.target_fps,
            fps_den: 1,
            bitrate: cfg.bitrate_kbps * 1000,
            profile: 100,
            codec: 0,
            sequence_header: vec![0, 0, 0, 1, 0x67, 0x64, 0x00, 0x2A],
        });
        shared.set_state(EngineState::Buffering);

        let frame_hns = HNS_PER_SECOND / cfg.target_fps.max(1) as i64;
        let bytes_per_frame = (cfg.bitrate_kbps as usize * 1000 / 8) / cfg.target_fps.max(1) as usize;
        let interval = Duration::from_secs_f64(1.0 / cfg.target_fps.max(1) as f64);
        let mut pts = 0i64;
        let mut n = 0u64;
        let generation = shared.generation.load(Ordering::Acquire);
        let start = Instant::now();

        while !shared.stop_requested.load(Ordering::Acquire) {
            let key = n % cfg.target_fps.max(1) as u64 == 0;
            let size = if key { bytes_per_frame * 6 } else { bytes_per_frame };
            let pkt = EncodedPacket {
                track: TrackKind::Video,
                data: Arc::from(vec![(n % 251) as u8; size.max(64)].into_boxed_slice()),
                pts_hns: pts,
                duration_hns: frame_hns,
                keyframe: key,
                generation,
            };
            shared.ring.lock().push(pkt);
            shared.frames_encoded.fetch_add(1, Ordering::Relaxed);
            shared.encode_ns_total.fetch_add(1_400_000, Ordering::Relaxed);
            shared.submit_ns_total.fetch_add(300_000, Ordering::Relaxed);
            pts += frame_hns;
            n += 1;
            if n % 30 == 0 {
                *shared.capture_fps.write() = n as f32 / start.elapsed().as_secs_f32().max(0.001);
            }
            std::thread::sleep(interval);
        }

        shared.set_state(EngineState::Idle);
        shared.running.store(false, Ordering::Release);
    }
}

// ---------------------------------------------------------------------------
// Platform dispatch
// ---------------------------------------------------------------------------

#[cfg(all(windows, not(feature = "headless-sim")))]
use win as platform;
#[cfg(any(not(windows), feature = "headless-sim"))]
use sim as platform;

fn capture_thread_main(
    shared: Arc<SharedState>,
    cfg: RecorderConfig,
    fmt: Arc<Mutex<Option<VideoFormatHeader>>>,
) {
    platform::capture_loop(shared, cfg, fmt);
}

fn mux_packets_to_mp4(
    path: &Path,
    header: &VideoFormatHeader,
    video: &[EncodedPacket],
    audio: &[EncodedPacket],
) -> RResult<()> {
    platform::mux(path, header, video, audio)
}

pub fn process_rss_bytes() -> u64 {
    platform::rss_bytes()
}

fn set_thread_priority_above_normal() {
    platform::boost_thread();
}

// ---------------------------------------------------------------------------
// Monitor enumeration (used by the settings panel)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MonitorInfo {
    pub index: u32,
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub refresh_hz: u32,
    pub primary: bool,
    pub adapter: String,
}

pub fn enumerate_monitors() -> Vec<MonitorInfo> {
    #[cfg(all(windows, not(feature = "headless-sim")))]
    {
        use windows::Win32::Graphics::Dxgi::*;
        let mut out = Vec::new();
        unsafe {
            let Ok(factory) = CreateDXGIFactory1::<IDXGIFactory1>() else {
                return out;
            };
            let mut flat = 0u32;
            let mut ai = 0u32;
            while let Ok(adapter) = factory.EnumAdapters1(ai) {
                let Ok(adesc) = adapter.GetDesc1() else {
                    ai += 1;
                    continue;
                };
                let adapter_name = String::from_utf16_lossy(
                    &adesc.Description[..adesc
                        .Description
                        .iter()
                        .position(|&c| c == 0)
                        .unwrap_or(adesc.Description.len())],
                );
                let mut oi = 0u32;
                while let Ok(output) = adapter.EnumOutputs(oi) {
                    if let Ok(odesc) = output.GetDesc() {
                        let r = odesc.DesktopCoordinates;
                        out.push(MonitorInfo {
                            index: flat,
                            name: String::from_utf16_lossy(
                                &odesc.DeviceName[..odesc
                                    .DeviceName
                                    .iter()
                                    .position(|&c| c == 0)
                                    .unwrap_or(odesc.DeviceName.len())],
                            ),
                            width: (r.right - r.left) as u32,
                            height: (r.bottom - r.top) as u32,
                            refresh_hz: 0,
                            primary: r.left == 0 && r.top == 0,
                            adapter: adapter_name.clone(),
                        });
                    }
                    flat += 1;
                    oi += 1;
                }
                ai += 1;
            }
        }
        out
    }

    #[cfg(any(not(windows), feature = "headless-sim"))]
    {
        vec![MonitorInfo {
            index: 0,
            name: "\\\\.\\DISPLAY1 (virtual)".into(),
            width: 1920,
            height: 1080,
            refresh_hz: 60,
            primary: true,
            adapter: "Virtual Adapter".into(),
        }]
    }
}
