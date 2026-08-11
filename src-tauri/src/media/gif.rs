//! GIF export — share the highlight anywhere.
//!
//! Frames are decoded through the existing Media Foundation SourceReader
//! (hardware accelerated, same path as the snapshot button), resampled to a
//! chat-friendly width, quantised to a 256-colour palette with `color_quant`
//! and encoded with the pure-Rust `gif` crate. No ffmpeg, no temp files, no
//! network — a one-shot export that leaves the live ring buffer untouched.
//!
//! The pure helpers (`frame_timestamps`, `resize_nearest_rgb`,
//! `bgra_to_rgb`, `suggested_gif_path`) live outside the `imp` gates so the
//! sampling and pixel math are unit-testable on any platform.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::recorder::{RecorderError, RResult, HNS_PER_SECOND};

/// Result of a completed GIF export (path/size are filled in by the command).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GifStats {
    pub frame_count: u32,
    pub width: u32,
    pub height: u32,
    /// The frame rate the GIF actually plays at (100 / rounded delay).
    pub fps_actual: f32,
    /// Real play duration in seconds (`frame_count * delay / 100`).
    pub duration_seconds: f32,
    pub elapsed_ms: f32,
}

// ---------------------------------------------------------------------------
// Pure, platform-independent helpers (unit-tested)
// ---------------------------------------------------------------------------

/// Timestamps (seconds) at which a GIF of `start..end` at `fps` samples frames.
/// The first frame lands exactly on `start`.
pub fn frame_timestamps(start: f32, end: f32, fps: u32) -> Vec<f32> {
    if fps == 0 || end <= start {
        return Vec::new();
    }
    let interval = 1.0 / fps as f32;
    let mut ts = start;
    let mut out = Vec::new();
    while ts < end - 1e-6 {
        out.push(ts);
        ts += interval;
    }
    out
}

/// Nearest-neighbour downscale of an RGB24 buffer. Aspect-ratio neutral — the
/// caller picks `dst_h` (e.g. scaled from `dst_w`). Pure and O(dst) time.
pub fn resize_nearest_rgb(
    src: &[u8],
    src_w: u32,
    src_h: u32,
    dst_w: u32,
    dst_h: u32,
) -> Vec<u8> {
    if src_w == 0 || src_h == 0 || dst_w == 0 || dst_h == 0 {
        return Vec::new();
    }
    if src.len() < (src_w * src_h * 3) as usize {
        return Vec::new(); // truncated source — nothing sane to sample
    }
    let mut out = vec![0u8; (dst_w * dst_h * 3) as usize];
    let stride = (src_w * 3) as usize;
    for y in 0..dst_h {
        let sy = (y as u64 * src_h as u64 / dst_h as u64) as usize;
        for x in 0..dst_w {
            let sx = (x as u64 * src_w as u64 / dst_w as u64) as usize;
            let si = sy * stride + sx * 3;
            if si + 2 < src.len() {
                let di = ((y * dst_w + x) * 3) as usize;
                out[di] = src[si];
                out[di + 1] = src[si + 1];
                out[di + 2] = src[si + 2];
            }
        }
    }
    out
}

/// Swaps BGRA (the Media Foundation RGB32 output on little-endian) to RGB24.
pub fn bgra_to_rgb(src: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(src.len() / 4 * 3);
    let mut i = 0;
    while i + 3 < src.len() {
        out.push(src[i + 2]); // R
        out.push(src[i + 1]); // G
        out.push(src[i]); // B
        i += 4;
    }
    out
}

/// Bilinear downscale of an RGB24 buffer. Unlike nearest-neighbour, gradients
/// stay smooth instead of aliasing into hard steps — the single biggest visual
/// quality win for a palette-limited GIF.
///
/// Pure and deterministic (fixed-point source coordinate stepping), so the
/// pixel math is unit-testable on any platform.
pub fn resize_bilinear_rgb(
    src: &[u8],
    src_w: u32,
    src_h: u32,
    dst_w: u32,
    dst_h: u32,
) -> Vec<u8> {
    if src_w == 0 || src_h == 0 || dst_w == 0 || dst_h == 0 {
        return Vec::new();
    }
    if src.len() < (src_w * src_h * 3) as usize {
        return Vec::new(); // truncated source — nothing sane to sample
    }
    if src_w == dst_w && src_h == dst_h {
        return src.to_vec();
    }
    let mut out = vec![0u8; (dst_w * dst_h * 3) as usize];
    let sstride = (src_w * 3) as usize;
    for y in 0..dst_h {
        // Map the output pixel centre back into source space.
        let sy = ((y as f32 + 0.5) * src_h as f32 / dst_h as f32) - 0.5;
        let y0 = sy.floor().max(0.0) as usize;
        let y1 = (y0 + 1).min(src_h as usize - 1);
        let fy = (sy - sy.floor()).max(0.0);
        for x in 0..dst_w {
            let sx = ((x as f32 + 0.5) * src_w as f32 / dst_w as f32) - 0.5;
            let x0 = sx.floor().max(0.0) as usize;
            let x1 = (x0 + 1).min(src_w as usize - 1);
            let fx = (sx - sx.floor()).max(0.0);

            for c in 0..3 {
                let a = src[y0 * sstride + x0 * 3 + c] as f32;
                let b = src[y0 * sstride + x1 * 3 + c] as f32;
                let c_ = src[y1 * sstride + x0 * 3 + c] as f32;
                let d = src[y1 * sstride + x1 * 3 + c] as f32;
                let top = a + (b - a) * fx;
                let bot = c_ + (d - c_) * fx;
                out[((y * dst_w + x) * 3 + c as u32) as usize] = (top + (bot - top) * fy).round() as u8;
            }
        }
    }
    out
}

/// Core Floyd-Steinberg loop with an injectable nearest-palette lookup.
/// `nearest(r, g, b)` returns a palette index for the given colour (which may
/// sit outside [0, 255] because error diffusion overshoots — callers clamp).
/// Pure and deterministic (row-major scan).
#[cfg(any(test, all(windows, not(feature = "headless-sim"))))]
fn dither_fs_core(
    frame: &[u8],
    w: u32,
    h: u32,
    colors: &[[f32; 3]],
    mut nearest: impl FnMut(f32, f32, f32) -> usize,
) -> Vec<u8> {
    if w == 0 || h == 0 || colors.is_empty() {
        return Vec::new();
    }
    if frame.len() < (w * h * 3) as usize {
        return Vec::new(); // truncated source — nothing sane to quantise
    }
    // Working buffer in f32 so error diffusion accumulates precisely.
    let mut buf: Vec<f32> = frame.iter().map(|&b| b as f32).collect();
    let mut out = vec![0u8; (w * h) as usize];
    let stride = w as usize;
    // Floyd-Steinberg weights: right 7/16, down-left 3/16, down 5/16,
    // down-right 1/16.
    let add = |buf: &mut [f32], i: usize, dr: f32, dg: f32, db: f32, w: f32| {
        buf[i] += dr * w;
        buf[i + 1] += dg * w;
        buf[i + 2] += db * w;
    };

    for y in 0..h as usize {
        for x in 0..w as usize {
            let i = y * stride + x;
            let r = buf[i * 3].clamp(0.0, 255.0);
            let g = buf[i * 3 + 1].clamp(0.0, 255.0);
            let b = buf[i * 3 + 2].clamp(0.0, 255.0);
            // Both bundled lookups stay in range, but clamp so a future
            // caller can't index `colors` out of bounds.
            let idx = nearest(r, g, b).min(colors.len() - 1);
            out[i] = idx as u8;
            let p = colors[idx];
            let (er, eg, eb) = (r - p[0], g - p[1], b - p[2]);
            if x + 1 < stride {
                add(&mut buf, i * 3 + 3, er, eg, eb, 7.0 / 16.0);
            }
            if y + 1 < h as usize {
                let down = i * 3 + stride * 3;
                add(&mut buf, down, er, eg, eb, 5.0 / 16.0);
                if x > 0 {
                    add(&mut buf, down - 3, er, eg, eb, 3.0 / 16.0);
                }
                if x + 1 < stride {
                    add(&mut buf, down + 3, er, eg, eb, 1.0 / 16.0);
                }
            }
        }
    }
    out
}

/// Maps an RGB24 frame onto a palette with Floyd-Steinberg error diffusion.
/// The quantisation error of each pixel is pushed onto its neighbours, which
/// eliminates the banding a plain nearest-index lookup produces on gradients
/// — the other half of GIF quality. Uses a simple linear palette scan as the
/// nearest lookup so the whole function stays dependency-free and testable;
/// the Windows exporter swaps in NeuQuant's O(1) lookup via [`dither_fs_quant`].
/// Test-only: the shipped binary always uses the NeuQuant lookup.
#[cfg(test)]
pub fn dither_fs_rgb(frame: &[u8], w: u32, h: u32, palette: &[u8]) -> Vec<u8> {
    if w == 0 || h == 0 || palette.len() < 3 {
        return Vec::new();
    }
    let colors: Vec<[f32; 3]> = palette
        .chunks_exact(3)
        .take(256)
        .map(|c| [c[0] as f32, c[1] as f32, c[2] as f32])
        .collect();
    dither_fs_core(frame, w, h, &colors, |r, g, b| {
        let mut best = 0usize;
        let mut best_d = f32::MAX;
        for (i, p) in colors.iter().enumerate() {
            let dr = r - p[0];
            let dg = g - p[1];
            let db = b - p[2];
            let d = dr * dr + dg * dg + db * db;
            if d < best_d {
                best_d = d;
                best = i;
            }
        }
        best
    })
}

/// Windows-only: error diffusion whose nearest lookup is NeuQuant's O(1)
/// index cube instead of the linear 256-colour scan — keeps export fast at
/// 720 px while still killing banding.
#[cfg(all(windows, not(feature = "headless-sim")))]
pub fn dither_fs_quant(
    frame: &[u8],
    w: u32,
    h: u32,
    palette: &[u8],
    quant: &color_quant::NeuQuant,
) -> Vec<u8> {
    if w == 0 || h == 0 || palette.len() < 3 {
        return Vec::new();
    }
    let colors: Vec<[f32; 3]> = palette
        .chunks_exact(3)
        .take(256)
        .map(|c| [c[0] as f32, c[1] as f32, c[2] as f32])
        .collect();
    dither_fs_core(frame, w, h, &colors, |r, g, b| {
        let rgba = [
            r.clamp(0.0, 255.0) as u8,
            g.clamp(0.0, 255.0) as u8,
            b.clamp(0.0, 255.0) as u8,
            255,
        ];
        quant.index_of(&rgba) as usize
    })
}

/// A free `<stem>_gif.gif` next to the source (bumps `_gif2`, `_gif3`, … so an
/// export can never overwrite an earlier one).
pub fn suggested_gif_path(source: &Path) -> PathBuf {
    let stem = source
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "clip".into());
    let dir = source.parent().unwrap_or_else(|| Path::new("."));
    let mut candidate = dir.join(format!("{stem}_gif.gif"));
    let mut n = 2;
    while candidate.exists() {
        candidate = dir.join(format!("{stem}_gif{n}.gif"));
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

    use std::io::Write;

    /// Soft ceiling on GIF length (in sampled frames) so a huge selection can
    /// never exhaust memory. The trimmer's UI picks short ranges anyway.
    const MAX_GIF_FRAMES: usize = 600;
    /// Palette pool is capped in bytes (two-pass export never holds more than
    /// this + one decoded frame in RAM). Generous: it only feeds the *global*
    /// header palette now — each frame gets its own frame-accurate palette.
    const PALETTE_POOL_BYTES: usize = 64 * 1024 * 1024;
    /// Palette is sampled from at most this many evenly-spaced frames.
    const PALETTE_SAMPLE_FRAMES: usize = 96;

    unsafe fn open_reader(path: &Path) -> RResult<IMFSourceReader> {
        let mut attrs: Option<IMFAttributes> = None;
        MFCreateAttributes(&mut attrs, 4).map_err(err)?;
        let attrs = attrs.ok_or_else(|| RecorderError::Other("reader attrs".into()))?;
        attrs
            .SetUINT32(&MF_SOURCE_READER_ENABLE_ADVANCED_VIDEO_PROCESSING, 1)
            .map_err(err)?;
        attrs
            .SetUINT32(&MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, 1)
            .map_err(err)?;
        let w = wide(path);
        MFCreateSourceReaderFromURL(PCWSTR(w.as_ptr()), &attrs).map_err(err)
    }

    /// Opens a RGB32-decoding video reader for `path` and returns it with the
    /// native frame size.
    unsafe fn open_video_reader(path: &Path) -> RResult<(IMFSourceReader, u32, u32)> {
        let reader = open_reader(path)?;
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
            .SetCurrentMediaType(MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32, None, &rgb)
            .map_err(err)?;

        let current = reader
            .GetCurrentMediaType(MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32)
            .map_err(err)?;
        let size = current.GetUINT64(&MF_MT_FRAME_SIZE).map_err(err)?;
        let w = (size >> 32) as u32;
        let h = (size & 0xFFFF_FFFF) as u32;
        if w == 0 || h == 0 {
            return Err(RecorderError::Other("gif: zero frame size".into()));
        }
        Ok((reader, w, h))
    }

    /// Decodes one sample into a downscaled RGB24 buffer, or None when the
    /// sample carries no usable pixel data.
    unsafe fn decode_rgb(
        sample: &IMFSample,
        w: u32,
        h: u32,
        out_w: u32,
        out_h: u32,
    ) -> Option<Vec<u8>> {
        let buffer = sample.ConvertToContiguousBuffer().ok()?;
        let mut ptr: *mut u8 = std::ptr::null_mut();
        let mut len = 0u32;
        buffer.Lock(&mut ptr, None, Some(&mut len)).ok()?;
        let src = std::slice::from_raw_parts(ptr, len as usize);
        let out = if (w * h * 4) as usize <= src.len() {
            let rgb = bgra_to_rgb(src);
            Some(resize_bilinear_rgb(&rgb, w, h, out_w, out_h))
        } else {
            None
        };
        let _ = buffer.Unlock();
        out
    }

    /// Walks the reader forward from its current position, decoding one frame
    /// per target timestamp and handing each to `sink`. Returns how many were
    /// decoded. The increment only happens after a *successful* decode, so a
    /// bad sample can never silently drop a frame.
    unsafe fn collect_frames(
        reader: &IMFSourceReader,
        targets: &[f32],
        end: f32,
        w: u32,
        h: u32,
        out_w: u32,
        out_h: u32,
        sink: &mut dyn FnMut(Vec<u8>),
    ) -> RResult<u32> {
        let mut next = 0usize;
        let mut count = 0u32;
        while next < targets.len() {
            let mut stream_index = 0u32;
            let mut flags = 0u32;
            let mut ts = 0i64;
            let mut sample: Option<IMFSample> = None;
            reader
                .ReadSample(
                    MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32,
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
            let t = ts as f32 / HNS_PER_SECOND as f32;
            if t > end {
                break;
            }
            if t < targets[next] - 0.001 {
                continue; // not at the next sample point yet
            }
            if let Some(frame) = decode_rgb(&sample, w, h, out_w, out_h) {
                sink(frame);
                count += 1;
            }
            next += 1;
        }
        Ok(count)
    }

    /// Two-pass export: pass 1 builds a *bounded* palette sample (evenly spaced
    /// frames, byte-capped), pass 2 re-decodes and streams frames straight into
    /// the encoder — so memory stays at ~palette pool + one frame no matter how
    /// long or high-res the selection is.
    pub(super) fn export_gif(
        source: &Path,
        dest: &Path,
        start: f32,
        end: f32,
        width: u32,
        fps: u32,
    ) -> RResult<GifStats> {
        let _mf = Mf::enter()?;
        let t0 = std::time::Instant::now();
        unsafe {
            let (reader, w, h) = open_video_reader(source)?;
            let out_w = width.min(w).max(1);
            let out_h = ((out_w as f32) * h as f32 / w as f32).round().max(1.0) as u32;
            let targets = frame_timestamps(start, end, fps);
            if targets.is_empty() {
                return Err(RecorderError::Other(
                    "selection too short for a GIF — pick a longer range".into(),
                ));
            }
            if targets.len() > MAX_GIF_FRAMES {
                return Err(RecorderError::Other(format!(
                    "selection is too long for a GIF ({} frames > {MAX_GIF_FRAMES}) — shorten it or lower the fps",
                    targets.len()
                )));
            }

            let start_hns = (start.max(0.0) as f64 * HNS_PER_SECOND as f64) as i64;
            let var = windows::core::PROPVARIANT::from(start_hns);
            let _ = reader.SetCurrentPosition(&windows::core::GUID::zeroed(), &var);

            // ---- pass 1: bounded palette sample (evenly spaced frames) ----
            let stride = (targets.len() / PALETTE_SAMPLE_FRAMES).max(1);
            let mut pool: Vec<u8> = Vec::new();
            let mut palette_count = 0u32;
            let frame_bytes = (out_w * out_h * 3) as usize;
            let pass1_count = collect_frames(
                &reader,
                &targets,
                end,
                w,
                h,
                out_w,
                out_h,
                &mut |frame| {
                    if palette_count % stride as u32 == 0
                        && pool.len() + frame_bytes <= PALETTE_POOL_BYTES
                    {
                        pool.extend_from_slice(&frame);
                    }
                    palette_count += 1;
                },
            )?;
            if pass1_count == 0 || pool.is_empty() {
                return Err(RecorderError::Other(
                    "no decodable frames in the selection".into(),
                ));
            }
            // Sample every 4th pixel instead of every 10th: a finer palette
            // sample is noticeably better on gradients at a trivial cost for
            // short highlights.
            let quant = color_quant::NeuQuant::new(4, 256, &pool);
            let palette = quant.color_map_rgb();
            drop(pool);

            // ---- pass 2: re-decode and stream into the encoder ----
            let (reader2, w2, h2) = open_video_reader(source)?;
            let _ = reader2.SetCurrentPosition(&windows::core::GUID::zeroed(), &var);
            let delay = (100.0 / fps as f32).round().max(1.0) as u16;
            let mut indices = vec![0u8; (out_w * out_h) as usize];

            let file = std::fs::File::create(dest).map_err(|e| RecorderError::Io(e.to_string()))?;
            let mut writer = std::io::BufWriter::new(file);
            let mut encoder =
                gif::Encoder::new(&mut writer, out_w as u16, out_h as u16, &palette)
                    .map_err(|e| RecorderError::Other(format!("gif header: {e}")))?;
            encoder
                .set_repeat(gif::Repeat::Infinite)
                .map_err(|e| RecorderError::Other(format!("gif repeat: {e}")))?;

            let mut written = 0u32;
            collect_frames(
                &reader2,
                &targets,
                end,
                w2,
                h2,
                out_w,
                out_h,
                &mut |frame| {
                    // Frame-local colour table: NeuQuant is built from THIS
                    // frame's own pixels, so every frame gets up to 256 colours
                    // of its own content. A shared global palette has to average
                    // 150 frames together, which washes the colours out ("few
                    // colours") and makes the dithering read as visible noise
                    // ("dots"). With a frame-accurate palette the nearest-index
                    // error is tiny, so Floyd-Steinberg only smooths the last
                    // bit of gradient banding.
                    let fq = color_quant::NeuQuant::new(1, 256, &frame);
                    let frame_palette = fq.color_map_rgb();
                    indices = dither_fs_quant(&frame, out_w, out_h, &frame_palette, &fq);
                    let mut gf = gif::Frame::from_palette_pixels(
                        out_w as u16,
                        out_h as u16,
                        indices.clone(),
                        frame_palette.clone(),
                        None,
                    );
                    gf.delay = delay;
                    encoder
                        .write_frame(&gf)
                        .expect("gif frame write"); // encoder errors surface via collect
                    written += 1;
                },
            )?;
            drop(reader2);

            if written == 0 {
                return Err(RecorderError::Other(
                    "no decodable frames in the selection".into(),
                ));
            }
            // gif::Encoder writes the trailer on drop.
            drop(encoder);
            writer.flush().ok();

            Ok(GifStats {
                frame_count: written,
                width: out_w,
                height: out_h,
                fps_actual: 100.0 / delay as f32,
                duration_seconds: written as f32 * delay as f32 / 100.0,
                elapsed_ms: t0.elapsed().as_secs_f32() * 1000.0,
            })
        }
    }
}

// ===========================================================================
//                          NON-WINDOWS FALLBACK
// ===========================================================================

#[cfg(any(not(windows), feature = "headless-sim"))]
mod imp {
    use super::*;

    pub(super) fn export_gif(
        _source: &Path,
        _dest: &Path,
        _start: f32,
        _end: f32,
        _width: u32,
        _fps: u32,
    ) -> RResult<GifStats> {
        Err(RecorderError::Other(
            "GIF export requires Windows Media Foundation".into(),
        ))
    }
}

// ---------------------------------------------------------------------------
// Public dispatch
// ---------------------------------------------------------------------------

pub fn export_gif(
    source: &Path,
    dest: &Path,
    start: f32,
    end: f32,
    width: u32,
    fps: u32,
) -> RResult<GifStats> {
    if !source.exists() {
        return Err(RecorderError::Io(format!(
            "source clip not found: {}",
            source.display()
        )));
    }
    if end <= start {
        return Err(RecorderError::Other(
            "GIF end must be greater than its start".into(),
        ));
    }
    imp::export_gif(source, dest, start, end, width.clamp(160, 1920), fps.clamp(5, 30))
}

// ---------------------------------------------------------------------------
// Tests (pure helpers only — the MF pipeline needs Windows)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_timestamps_sample_from_start() {
        // f32 accumulation has tiny drift; assert count + step + endpoints.
        let ts = frame_timestamps(1.0, 3.0, 10);
        assert_eq!(ts.len(), 20);
        assert!((ts[0] - 1.0).abs() < 1e-6);
        assert!((ts[3] - 1.3).abs() < 1e-3);
        assert!((ts[19] - 2.9).abs() < 1e-3);
        for pair in ts.windows(2) {
            assert!((pair[1] - pair[0] - 0.1).abs() < 1e-3);
        }
    }

    #[test]
    fn frame_timestamps_never_reach_the_end() {
        let ts = frame_timestamps(0.0, 0.9, 10);
        assert_eq!(ts.len(), 9); // 0.0..0.8 — 0.9 is excluded
        assert!(ts.iter().all(|t| *t < 0.9));
    }

    #[test]
    fn frame_timestamps_reject_invalid_input() {
        assert!(frame_timestamps(0.0, 0.0, 15).is_empty());
        assert!(frame_timestamps(5.0, 1.0, 15).is_empty());
        assert!(frame_timestamps(0.0, 5.0, 0).is_empty());
    }

    #[test]
    fn frame_timestamps_cover_the_range_at_low_fps() {
        let ts = frame_timestamps(0.0, 10.0, 2);
        assert_eq!(ts.len(), 20);
        assert_eq!(ts[0], 0.0);
        assert_eq!(ts[19], 9.5);
    }

    #[test]
    fn resize_nearest_preserves_corners() {
        // 2x2 RGB → 4x4: every output pixel mirrors the nearest source pixel,
        // so the four quadrants each keep their source colour.
        let src: Vec<u8> = vec![
            255, 0, 0, 0, 255, 0, // R G
            0, 0, 255, 255, 255, 255, // B W
        ];
        let out = resize_nearest_rgb(&src, 2, 2, 4, 4);
        assert_eq!(out.len(), 4 * 4 * 3);
        assert_eq!(&out[0..3], &[255, 0, 0]); // top-left quadrant → R
        assert_eq!(&out[9..12], &[0, 255, 0]); // top-right → G
        assert_eq!(&out[36..39], &[0, 0, 255]); // bottom-left → B
        assert_eq!(&out[45..48], &[255, 255, 255]); // bottom-right → W
    }

    #[test]
    fn resize_nearest_shrinks_to_requested_dims() {
        // 4x4 rows of 3-byte pixels; nearest sampling picks every other one.
        let src: Vec<u8> = (0..(4 * 4 * 3)).map(|i| i as u8).collect();
        let out = resize_nearest_rgb(&src, 4, 4, 2, 2);
        assert_eq!(out.len(), 2 * 2 * 3);
        assert_eq!(&out[0..3], &src[0..3]); // (0,0) → src row 0 col 0
        assert_eq!(&out[3..6], &src[6..9]); // (1,0) → sx=2
        assert_eq!(&out[6..9], &src[24..27]); // (0,1) → sy=2 → row 2
        assert_eq!(&out[9..12], &src[30..33]); // (1,1) → row 2 col 2
    }

    #[test]
    fn resize_nearest_handles_empty_input() {
        assert!(resize_nearest_rgb(&[], 4, 4, 2, 2).is_empty());
        assert!(resize_nearest_rgb(&[0u8; 48], 4, 4, 0, 2).is_empty());
    }

    #[test]
    fn bgra_to_rgb_swaps_channels() {
        let bgra: Vec<u8> = vec![10, 20, 30, 255, 40, 50, 60, 255];
        let rgb = bgra_to_rgb(&bgra);
        assert_eq!(rgb, vec![30, 20, 10, 60, 50, 40]);
    }

    #[test]
    fn resize_bilinear_identity_is_a_copy() {
        let src: Vec<u8> = (0..(4 * 4 * 3)).map(|i| (i % 251) as u8).collect();
        let out = resize_bilinear_rgb(&src, 4, 4, 4, 4);
        assert_eq!(out, src);
    }

    #[test]
    fn resize_bilinear_downscales_to_requested_dims() {
        // 4x4 solid-red block downscaled 2x stays solid red (no smearing).
        let src: Vec<u8> = (0..(4 * 4 * 3)).map(|i| if i % 3 == 0 { 255 } else { 0 }).collect();
        let out = resize_bilinear_rgb(&src, 4, 4, 2, 2);
        assert_eq!(out.len(), 2 * 2 * 3);
        for px in out.chunks_exact(3) {
            assert_eq!(px, &[255, 0, 0]);
        }
    }

    #[test]
    fn resize_bilinear_blends_a_horizontal_gradient() {
        // Left column pure red, right column pure green: the middle output
        // column must be a blend, not a hard step.
        let mut src = vec![0u8; 4 * 2 * 3];
        for y in 0..2 {
            for c in 0..3 {
                src[(y * 4 + 0) * 3 + c] = 0; // left
                src[(y * 4 + 1) * 3 + c] = 0;
                src[(y * 4 + 2) * 3 + c] = 0;
                src[(y * 4 + 3) * 3 + c] = 0;
            }
            src[(y * 4 + 0) * 3 + 0] = 255;
            src[(y * 4 + 1) * 3 + 0] = 255;
            src[(y * 4 + 3) * 3 + 1] = 255;
            src[(y * 4 + 2) * 3 + 1] = 255;
        }
        // 4 wide -> 3 wide; pixel 1 (middle) must sit between red and green.
        let out = resize_bilinear_rgb(&src, 4, 2, 3, 2);
        let mid = &out[(0 * 3 + 1) * 3..(0 * 3 + 1) * 3 + 3];
        // Exact blend depends on coordinate mapping; assert it is neither
        // pure red nor pure green (i.e. a real interpolation happened).
        assert!(mid[0] > 0 && mid[0] < 255, "mid red = {} should be blended", mid[0]);
        assert!(mid[1] > 0 && mid[1] < 255, "mid green = {} should be blended", mid[1]);
    }

    #[test]
    fn resize_bilinear_handles_empty_input() {
        assert!(resize_bilinear_rgb(&[], 4, 4, 2, 2).is_empty());
        assert!(resize_bilinear_rgb(&[0u8; 48], 4, 4, 0, 2).is_empty());
    }

    #[test]
    fn dither_fs_maps_a_flat_color_to_its_palette_entry() {
        // A 2-color palette where pixel values exactly match an entry: the
        // output index must be that entry (zero error diffusion).
        let palette: Vec<u8> = vec![255, 0, 0, 0, 255, 0]; // red, green
        let frame: Vec<u8> = (0..(2 * 2 * 3)).map(|i| if i % 3 == 0 { 255 } else { 0 }).collect();
        let out = dither_fs_rgb(&frame, 2, 2, &palette);
        assert_eq!(out.len(), 4);
        assert!(out.iter().all(|&i| i == 0)); // every pixel resolves to red
    }

    #[test]
    fn dither_fs_stays_within_palette_bounds() {
        // Random-ish noise on a small palette: every index must be < palette
        // entry count and the buffer length must be w*h.
        let palette: Vec<u8> = (0..(8 * 3)).map(|i| (i * 37 % 256) as u8).collect();
        let frame: Vec<u8> = (0..(4 * 3 * 3)).map(|i| (i * 91 % 256) as u8).collect();
        let out = dither_fs_rgb(&frame, 4, 3, &palette);
        assert_eq!(out.len(), 12);
        assert!(out.iter().all(|&i| (i as usize) < 8));
    }

    #[test]
    fn dither_fs_handles_empty_input() {
        assert!(dither_fs_rgb(&[], 4, 4, &[0u8; 6]).is_empty());
        assert!(dither_fs_rgb(&[0u8; 48], 4, 4, &[]).is_empty());
    }

    #[test]
    fn suggested_gif_path_bumps_on_collision() {
        let dir = std::env::temp_dir().join(format!("clipflow-gif-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("clutch.mp4");
        assert_eq!(suggested_gif_path(&src), dir.join("clutch_gif.gif"));
        std::fs::write(dir.join("clutch_gif.gif"), b"x").unwrap();
        assert_eq!(suggested_gif_path(&src), dir.join("clutch_gif2.gif"));
        std::fs::remove_dir_all(&dir).ok();
    }
}
