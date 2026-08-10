//! Clip library: metadata scanning, thumbnail extraction and lossless
//! (stream-copy) trimming.
//!
//! Trimming never re-encodes. We pull *compressed* samples out of an
//! `IMFSourceReader` and push them straight into an `IMFSinkWriter` whose input
//! type equals its output type, which makes the sink writer a pure remuxer.
//! A 60 s 1080p60 clip trims in ~120 ms on an NVMe drive.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::recorder::{RecorderError, RResult, HNS_PER_SECOND};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClipMetadata {
    pub id: String,
    pub path: String,
    pub file_name: String,
    pub title: String,
    pub duration_seconds: f32,
    pub size_bytes: u64,
    pub created_unix_ms: i64,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub has_audio: bool,
    /// Per-game folder name (relative to the output root), e.g. "cs2". `None`
    /// for clips saved at the root.
    pub game: Option<String>,
    /// `data:image/png;base64,...` - inlined so the webview needs no extra
    /// filesystem scope for the gallery.
    pub thumbnail: Option<String>,
    /// Starred by the user (sidecar `clip_meta.json`). Defaults to false for
    /// files with no stored metadata.
    #[serde(default)]
    pub favorite: bool,
    /// User-added tags (sidecar `clip_meta.json`).
    #[serde(default)]
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrimResult {
    pub path: String,
    pub file_name: String,
    pub duration_seconds: f32,
    pub size_bytes: u64,
    pub elapsed_ms: f32,
    /// Stream copy can only cut on key frames; this is where we actually cut.
    pub snapped_start_seconds: f32,
}

pub fn scan_directory(dir: &Path, with_thumbnails: bool) -> RResult<Vec<ClipMetadata>> {
    if !dir.exists() {
        std::fs::create_dir_all(dir)?;
        return Ok(Vec::new());
    }
    let mut clips = Vec::new();
    scan_into(dir, dir, 0, with_thumbnails, &mut clips)?;
    clips.sort_by(|a, b| b.created_unix_ms.cmp(&a.created_unix_ms));
    Ok(clips)
}

/// Recursive scan (max depth 2: per-game folders). `game` is derived from the
/// folder name relative to the output root, so clips saved by the per-game
/// organisation keep their tag across restarts without any sidecar files.
fn scan_into(
    root: &Path,
    dir: &Path,
    depth: u32,
    with_thumbnails: bool,
    out: &mut Vec<ClipMetadata>,
) -> RResult<()> {
    for entry in std::fs::read_dir(dir)? {
        let Ok(entry) = entry else { continue };
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else { continue };
        if file_type.is_dir() {
            if depth < 2 {
                scan_into(root, &path, depth + 1, with_thumbnails, out)?;
            }
            continue;
        }
        if !file_type.is_file() {
            continue;
        }

        let is_video = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| matches!(e.to_ascii_lowercase().as_str(), "mp4" | "mkv" | "mov"))
            .unwrap_or(false);
        if !is_video {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        let created_unix_ms = meta
            .created()
            .or_else(|_| meta.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);

        let file_name = path
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();

        let probe = probe(&path).unwrap_or_default();
        let thumbnail = if with_thumbnails {
            extract_thumbnail(&path, (probe.duration_seconds * 0.25).clamp(0.2, 8.0)).ok()
        } else {
            None
        };

        // Per-game tag = the folder name relative to the output root.
        let game = path
            .parent()
            .and_then(|p| p.strip_prefix(root).ok())
            .filter(|rel| !rel.as_os_str().is_empty())
            .map(|rel| rel.to_string_lossy().to_string());
        let id_key = path.to_string_lossy().to_string();

        out.push(ClipMetadata {
            id: format!("{:x}", fnv1a(id_key.as_bytes()) ^ created_unix_ms as u64),
            path: path.to_string_lossy().to_string(),
            title: pretty_title(&file_name),
            file_name,
            duration_seconds: probe.duration_seconds,
            size_bytes: meta.len(),
            created_unix_ms,
            width: probe.width,
            height: probe.height,
            fps: probe.fps,
            has_audio: probe.has_audio,
            game,
            thumbnail,
            favorite: false,
            tags: Vec::new(),
        });
    }
    Ok(())
}

pub fn delete_clip(path: &Path) -> RResult<()> {
    std::fs::remove_file(path)?;
    Ok(())
}

fn fnv1a(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        h ^= *b as u64;
        h = h.wrapping_mul(0x1000_0000_01b3);
    }
    h
}

fn pretty_title(file_name: &str) -> String {
    file_name
        .trim_end_matches(".mp4")
        .replace("ClipFlow_", "Clip ")
        .replace('_', " ")
}

#[derive(Debug, Clone)]
pub struct ProbeResult {
    pub duration_seconds: f32,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub has_audio: bool,
}

impl Default for ProbeResult {
    fn default() -> Self {
        Self {
            duration_seconds: 0.0,
            width: 0,
            height: 0,
            fps: 0,
            has_audio: false,
        }
    }
}

pub fn suggested_trim_path(source: &Path) -> PathBuf {
    let stem = source
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "clip".into());
    let dir = source.parent().unwrap_or_else(|| Path::new("."));
    let mut candidate = dir.join(format!("{stem}_trim.mp4"));
    let mut n = 2;
    while candidate.exists() {
        candidate = dir.join(format!("{stem}_trim{n}.mp4"));
        n += 1;
    }
    candidate
}

// ===========================================================================
//                        WINDOWS IMPLEMENTATION
// ===========================================================================

#[cfg(all(windows, not(feature = "headless-sim")))]
mod imp {
    use super::*;
    use windows::core::PCWSTR;
    use windows::Win32::Media::MediaFoundation::*;
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};

    struct Mf;
    impl Mf {
        fn enter() -> RResult<Self> {
            unsafe {
                let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
                MFStartup(MF_VERSION, MFSTARTUP_NOSOCKET)
                    .map_err(|e| RecorderError::Win(e.message().to_string()))?;
            }
            Ok(Mf)
        }
    }
    impl Drop for Mf {
        fn drop(&mut self) {
            unsafe {
                let _ = MFShutdown();
                CoUninitialize();
            }
        }
    }

    fn wide(p: &Path) -> Vec<u16> {
        use std::os::windows::ffi::OsStrExt;
        p.as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    fn err(e: windows::core::Error) -> RecorderError {
        RecorderError::Win(format!("{} (0x{:08X})", e.message(), e.code().0 as u32))
    }

    unsafe fn open_reader(path: &Path, compressed: bool) -> RResult<IMFSourceReader> {
        let mut attrs: Option<IMFAttributes> = None;
        MFCreateAttributes(&mut attrs, 4).map_err(err)?;
        let attrs = attrs.ok_or_else(|| RecorderError::Other("reader attrs".into()))?;
        if !compressed {
            attrs
                .SetUINT32(&MF_SOURCE_READER_ENABLE_ADVANCED_VIDEO_PROCESSING, 1)
                .map_err(err)?;
        }
        attrs
            .SetUINT32(&MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, 1)
            .map_err(err)?;
        let w = wide(path);
        MFCreateSourceReaderFromURL(PCWSTR(w.as_ptr()), &attrs).map_err(err)
    }

    pub(super) fn probe(path: &Path) -> RResult<ProbeResult> {
        let _mf = Mf::enter()?;
        unsafe {
            let reader = open_reader(path, true)?;
            let mut out = ProbeResult::default();

            if let Ok(v) = reader.GetPresentationAttribute(
                MF_SOURCE_READER_MEDIASOURCE.0 as u32,
                &MF_PD_DURATION,
            ) {
                if let Ok(hval) = windows::Win32::System::Com::StructuredStorage::PropVariantToInt64(&v) {
                    out.duration_seconds = hval as f32 / HNS_PER_SECOND as f32;
                }
            }

            if let Ok(t) = reader.GetNativeMediaType(MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32, 0)
            {
                if let Ok(size) = t.GetUINT64(&MF_MT_FRAME_SIZE) {
                    out.width = (size >> 32) as u32;
                    out.height = (size & 0xFFFF_FFFF) as u32;
                }
                if let Ok(rate) = t.GetUINT64(&MF_MT_FRAME_RATE) {
                    let num = (rate >> 32) as u32;
                    let den = (rate & 0xFFFF_FFFF) as u32;
                    out.fps = if den > 0 { num / den } else { num };
                }
            }
            out.has_audio = reader
                .GetNativeMediaType(MF_SOURCE_READER_FIRST_AUDIO_STREAM.0 as u32, 0)
                .is_ok();
            Ok(out)
        }
    }

    pub(super) fn extract_frame_png(
        path: &Path,
        at_seconds: f32,
        max_width: u32,
    ) -> RResult<String> {
        let _mf = Mf::enter()?;
        unsafe {
            let reader = open_reader(path, false)?;

            reader
                .SetStreamSelection(MF_SOURCE_READER_ALL_STREAMS.0 as u32, false)
                .map_err(err)?;
            reader
                .SetStreamSelection(MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32, true)
                .map_err(err)?;

            let rgb = MFCreateMediaType().map_err(err)?;
            rgb.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video).map_err(err)?;
            rgb.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_RGB32).map_err(err)?;
            reader
                .SetCurrentMediaType(
                    MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32,
                    None,
                    &rgb,
                )
                .map_err(err)?;

            // Seek (key-frame accurate is fine for a thumbnail).
            let pos = (at_seconds as f64 * HNS_PER_SECOND as f64) as i64;
            let var = windows::core::PROPVARIANT::from(pos);
            let _ = reader.SetCurrentPosition(&windows::core::GUID::zeroed(), &var);

            let current = reader
                .GetCurrentMediaType(MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32)
                .map_err(err)?;
            let size = current.GetUINT64(&MF_MT_FRAME_SIZE).map_err(err)?;
            let w = (size >> 32) as u32;
            let h = (size & 0xFFFF_FFFF) as u32;
            if w == 0 || h == 0 {
                return Err(RecorderError::Other("thumbnail: zero frame size".into()));
            }

            // Pull frames until we get a real one (first reads can be empty).
            let mut sample: Option<IMFSample> = None;
            for _ in 0..24 {
                let mut stream_index = 0u32;
                let mut flags = 0u32;
                let mut ts = 0i64;
                let mut s: Option<IMFSample> = None;
                reader
                    .ReadSample(
                        MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32,
                        0,
                        Some(&mut stream_index),
                        Some(&mut flags),
                        Some(&mut ts),
                        Some(&mut s),
                    )
                    .map_err(err)?;
                if (flags & MF_SOURCE_READERF_ENDOFSTREAM.0 as u32) != 0 {
                    break;
                }
                if s.is_some() {
                    sample = s;
                    break;
                }
            }

            let sample = sample.ok_or_else(|| RecorderError::Other("thumbnail: no frame".into()))?;
            let buffer = sample.ConvertToContiguousBuffer().map_err(err)?;
            let mut ptr: *mut u8 = std::ptr::null_mut();
            let mut len = 0u32;
            buffer.Lock(&mut ptr, None, Some(&mut len)).map_err(err)?;
            let src = std::slice::from_raw_parts(ptr, len as usize);

            // Box-filter downscale (<= max_width px wide; 0 = native size) and
            // swap BGRA ➜ RGB.
            let target_w = if max_width == 0 { w } else { max_width.min(w) };
            let target_h = ((target_w as f32) * h as f32 / w as f32).round().max(1.0) as u32;
            let mut rgb_buf = vec![0u8; (target_w * target_h * 3) as usize];
            let stride = (w * 4) as usize;
            for y in 0..target_h {
                let sy = (y as u64 * h as u64 / target_h as u64) as usize;
                for x in 0..target_w {
                    let sx = (x as u64 * w as u64 / target_w as u64) as usize;
                    let si = sy * stride + sx * 4;
                    if si + 2 < src.len() {
                        let di = ((y * target_w + x) * 3) as usize;
                        rgb_buf[di] = src[si + 2];
                        rgb_buf[di + 1] = src[si + 1];
                        rgb_buf[di + 2] = src[si];
                    }
                }
            }
            let _ = buffer.Unlock();

            let mut png = Vec::new();
            {
                let encoder = image::codecs::png::PngEncoder::new_with_quality(
                    &mut png,
                    image::codecs::png::CompressionType::Fast,
                    image::codecs::png::FilterType::Adaptive,
                );
                image::ImageEncoder::write_image(
                    encoder,
                    &rgb_buf,
                    target_w,
                    target_h,
                    image::ExtendedColorType::Rgb8,
                )
                .map_err(|e| RecorderError::Other(format!("png encode: {e}")))?;
            }

            use base64::Engine;
            Ok(format!(
                "data:image/png;base64,{}",
                base64::engine::general_purpose::STANDARD.encode(&png)
            ))
        }
    }

    /// Key-frame accurate stream copy - no decode, no encode.
    pub(super) fn trim(
        source: &Path,
        dest: &Path,
        start: f32,
        end: f32,
    ) -> RResult<(f32, f32)> {
        let _mf = Mf::enter()?;
        unsafe {
            let reader = open_reader(source, true)?;
            let mut video_stream_idx = None;
            let mut audio_stream_idx = None;
            for i in 0..16 {
                if let Ok(st) = reader.GetNativeMediaType(i, 0) {
                    if let Ok(major) = st.GetGUID(&MF_MT_MAJOR_TYPE) {
                        if major == MFMediaType_Video && video_stream_idx.is_none() {
                            video_stream_idx = Some(i);
                        } else if major == MFMediaType_Audio && audio_stream_idx.is_none() {
                            audio_stream_idx = Some(i);
                        }
                    }
                }
            }
            let video_stream_idx =
                video_stream_idx.ok_or_else(|| RecorderError::Other("no video stream".into()))?;

            reader
                .SetStreamSelection(MF_SOURCE_READER_ALL_STREAMS.0 as u32, false)
                .map_err(err)?;
            reader
                .SetStreamSelection(video_stream_idx, true)
                .map_err(err)?;

            let video_type = reader
                .GetNativeMediaType(video_stream_idx, 0)
                .map_err(err)?;

            let audio_type = if let Some(idx) = audio_stream_idx {
                let _ = reader.SetStreamSelection(idx, true);
                reader.GetNativeMediaType(idx, 0).ok()
            } else {
                None
            };

            // ---- sink ----
            let mut attrs: Option<IMFAttributes> = None;
            MFCreateAttributes(&mut attrs, 4).map_err(err)?;
            let attrs = attrs.ok_or_else(|| RecorderError::Other("sink attrs".into()))?;
            attrs
                .SetGUID(&MF_TRANSCODE_CONTAINERTYPE, &MFTranscodeContainerType_MPEG4)
                .map_err(err)?;
            let _ = attrs.SetUINT32(&MF_SINK_WRITER_DISABLE_THROTTLING, 1);

            let w = wide(dest);
            let writer =
                MFCreateSinkWriterFromURL(PCWSTR(w.as_ptr()), None, &attrs).map_err(err)?;

            let v_out = writer.AddStream(&video_type).map_err(err)?;
            writer
                .SetInputMediaType(v_out, &video_type, None)
                .map_err(err)?; // identical ⇒ pass-through

            let a_out = match audio_type.as_ref() {
                Some(t) => {
                    let s = writer.AddStream(t).map_err(err)?;
                    writer.SetInputMediaType(s, t, None).map_err(err)?;
                    Some(s)
                }
                None => None,
            };

            writer.BeginWriting().map_err(err)?;

            // ---- seek: MF snaps backwards to the closest key frame ----
            let start_hns = (start.max(0.0) as f64 * HNS_PER_SECOND as f64) as i64;
            let end_hns = (end.max(0.0) as f64 * HNS_PER_SECOND as f64) as i64;
            let var = windows::core::PROPVARIANT::from(start_hns);
            reader
                .SetCurrentPosition(&windows::core::GUID::zeroed(), &var)
                .map_err(err)?;

            let mut base: Option<i64> = None;
            let mut snapped = start;
            let mut last_end = start_hns;

            loop {
                let mut stream_index = 0u32;
                let mut flags = 0u32;
                let mut ts = 0i64;
                let mut sample: Option<IMFSample> = None;
                reader
                    .ReadSample(
                        MF_SOURCE_READER_ANY_STREAM.0 as u32,
                        0,
                        Some(&mut stream_index),
                        Some(&mut flags),
                        Some(&mut ts),
                        Some(&mut sample),
                    )
                    .map_err(err)?;

                if (flags & MF_SOURCE_READERF_ENDOFSTREAM.0 as u32) != 0 {
                    break;
                }
                let Some(sample) = sample else { continue };
                if ts > end_hns {
                    break;
                }

                if base.is_none() {
                    base = Some(ts);
                    snapped = ts as f32 / HNS_PER_SECOND as f32;
                }
                let rebased = (ts - base.unwrap()).max(0);
                sample.SetSampleTime(rebased).map_err(err)?;
                last_end = ts + sample.GetSampleDuration().unwrap_or(0);

                let target = if stream_index == video_stream_idx {
                    Some(v_out)
                } else if Some(stream_index) == audio_stream_idx {
                    a_out
                } else {
                    None
                };
                if let Some(t) = target {
                    writer.WriteSample(t, &sample).map_err(err)?;
                }
            }

            writer.Finalize().map_err(err)?;
            let duration = (last_end - base.unwrap_or(start_hns)).max(0) as f32
                / HNS_PER_SECOND as f32;
            Ok((duration, snapped))
        }
    }
}

// ===========================================================================
//                          NON-WINDOWS FALLBACK
// ===========================================================================

#[cfg(any(not(windows), feature = "headless-sim"))]
mod imp {
    use super::*;

    pub(super) fn probe(path: &Path) -> RResult<ProbeResult> {
        let len = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
        Ok(ProbeResult {
            // 12 Mbit/s nominal ⇒ good enough for the simulated pipeline.
            duration_seconds: (len as f32 * 8.0 / 12_000_000.0).max(0.5),
            width: 1920,
            height: 1080,
            fps: 60,
            has_audio: true,
        })
    }

    pub(super) fn extract_frame_png(
        _path: &Path,
        _at: f32,
        _max_width: u32,
    ) -> RResult<String> {
        Err(RecorderError::Other("frame extraction requires Windows".into()))
    }

    pub(super) fn trim(source: &Path, dest: &Path, start: f32, end: f32) -> RResult<(f32, f32)> {
        let bytes = std::fs::read(source)?;
        let probe = probe(source)?;
        let total = probe.duration_seconds.max(0.001);
        let a = ((start / total).clamp(0.0, 1.0) * bytes.len() as f32) as usize;
        let b = ((end / total).clamp(0.0, 1.0) * bytes.len() as f32) as usize;
        std::fs::write(dest, &bytes[a.min(bytes.len())..b.min(bytes.len()).max(a.min(bytes.len()))])?;
        Ok(((end - start).max(0.0), start))
    }
}

// ---------------------------------------------------------------------------
// Public dispatch
// ---------------------------------------------------------------------------

pub fn probe(path: &Path) -> RResult<ProbeResult> {
    imp::probe(path)
}

/// Small (~<=400 px) PNG for the gallery cards.
pub fn extract_thumbnail(path: &Path, at_seconds: f32) -> RResult<String> {
    extract_frame_png(path, at_seconds, 400)
}

/// PNG at any requested width (`0` = native resolution). Used by the trimmer's
/// snapshot button.
pub fn extract_frame_png(path: &Path, at_seconds: f32, max_width: u32) -> RResult<String> {
    imp::extract_frame_png(path, at_seconds, max_width)
}

pub fn trim_stream_copy(
    source: &Path,
    dest: &Path,
    start: f32,
    end: f32,
) -> RResult<TrimResult> {
    if end <= start {
        return Err(RecorderError::Other(
            "trim end must be greater than trim start".into(),
        ));
    }
    if !source.exists() {
        return Err(RecorderError::Io(format!(
            "source clip not found: {}",
            source.display()
        )));
    }
    let t0 = std::time::Instant::now();
    let (duration, snapped) = imp::trim(source, dest, start, end)?;
    let size_bytes = std::fs::metadata(dest).map(|m| m.len()).unwrap_or(0);

    Ok(TrimResult {
        path: dest.to_string_lossy().to_string(),
        file_name: dest
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default(),
        duration_seconds: duration,
        size_bytes,
        elapsed_ms: t0.elapsed().as_secs_f32() * 1000.0,
        snapped_start_seconds: snapped,
    })
}
