//! WASAPI loopback + microphone capture, mixed and AAC-encoded into the same
//! rolling ring buffer that holds the video packets.
//!
//! Drift avoidance
//! ---------------
//! WASAPI hands every packet a QPC timestamp taken by the audio engine itself.
//! We convert that stamp with exactly the same [`QpcClock`] epoch the capture
//! thread uses for video, so A/V share one monotonic timeline. No resampling
//! guesswork, no "add 40 ms and hope" - the muxer just writes the stamps.
//!
//! The mic is mixed into the loopback stream in the float domain with a -3 dB
//! pad on both sources to avoid inter-sample clipping.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;

use parking_lot::Mutex;

use super::recorder::{EncodedPacket, RecorderError, RollingRingBuffer, TrackKind, HNS_PER_SECOND};

pub const SAMPLE_RATE: u32 = 48_000;
pub const CHANNELS: u32 = 2;
pub const AAC_BYTES_PER_SECOND: u32 = 24_000; // 192 kbit/s stereo

pub struct AudioCapture {
    stop: Arc<AtomicBool>,
    handles: Vec<std::thread::JoinHandle<()>>,
}

impl AudioCapture {
    pub fn start(
        system: bool,
        mic: bool,
        ring: Arc<Mutex<RollingRingBuffer>>,
        generation: Arc<AtomicU32>,
    ) -> Result<Self, RecorderError> {
        let stop = Arc::new(AtomicBool::new(false));
        let mut handles = Vec::new();

        if system || mic {
            let stop_c = Arc::clone(&stop);
            let ring_c = Arc::clone(&ring);
            let gen_c = Arc::clone(&generation);
            let h = std::thread::Builder::new()
                .name("clipflow-audio".into())
                .spawn(move || {
                    imp::run(system, mic, stop_c, ring_c, gen_c);
                })
                .map_err(|e| RecorderError::Other(format!("audio thread: {e}")))?;
            handles.push(h);
        }

        Ok(Self { stop, handles })
    }

    pub fn stop(self) {
        self.stop.store(true, Ordering::Release);
        for h in self.handles {
            let _ = h.join();
        }
    }
}

// ---------------------------------------------------------------------------
// Windows implementation
// ---------------------------------------------------------------------------

#[cfg(all(windows, not(feature = "headless-sim")))]
mod imp {
    use super::*;
    use windows::Win32::Media::Audio::*;
    use windows::Win32::Media::MediaFoundation::*;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_ALL,
        COINIT_MULTITHREADED,
    };
    use windows::Win32::System::Performance::{QueryPerformanceCounter, QueryPerformanceFrequency};

    const KSDATAFORMAT_SUBTYPE_IEEE_FLOAT: windows::core::GUID =
        windows::core::GUID::from_u128(0x00000003_0000_0010_8000_00aa00389b71);

    struct Endpoint {
        client: IAudioClient,
        capture: IAudioCaptureClient,
        channels: u32,
        _rate: u32,
        float: bool,
        bits: u32,
    }

    unsafe fn open_endpoint(loopback: bool) -> windows::core::Result<Endpoint> {
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
        let device = enumerator.GetDefaultAudioEndpoint(
            if loopback { eRender } else { eCapture },
            eConsole,
        )?;
        let client: IAudioClient = device.Activate(CLSCTX_ALL, None)?;
        let mix = client.GetMixFormat()?;
        let wf = &*mix;

        let mut flags = AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM;
        if loopback {
            // Loopback streams cannot be event driven on all drivers; poll them.
            flags = AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM;
        }

        client.Initialize(
            AUDCLNT_SHAREMODE_SHARED,
            flags,
            20_0000, // 20 ms buffer in 100 ns units
            0,
            mix,
            None,
        )?;

        let capture: IAudioCaptureClient = client.GetService()?;
        let channels = wf.nChannels as u32;
        let rate = wf.nSamplesPerSec;
        let bits = wf.wBitsPerSample as u32;

        // Determine sample encoding (mix format is virtually always 32-bit float).
        let float = if wf.wFormatTag == 0xFFFE {
            let ext = mix as *const WAVEFORMATEXTENSIBLE;
            let subformat = unsafe { std::ptr::addr_of!((*ext).SubFormat).read_unaligned() };
            subformat == KSDATAFORMAT_SUBTYPE_IEEE_FLOAT
        } else {
            wf.wFormatTag == 3
        };

        client.Start()?;
        CoTaskMemFree(Some(mix as *const std::ffi::c_void));

        Ok(Endpoint {
            client,
            capture,
            channels,
            _rate: rate,
            float,
            bits,
        })
    }

    unsafe fn drain_endpoint(ep: &Endpoint, out: &mut Vec<f32>, qpc_first: &mut Option<i64>) {
        loop {
            let packet = match ep.capture.GetNextPacketSize() {
                Ok(p) => p,
                Err(_) => return,
            };
            if packet == 0 {
                return;
            }
            let mut data: *mut u8 = std::ptr::null_mut();
            let mut frames = 0u32;
            let mut flags = 0u32;
            let mut dev_pos = 0u64;
            let mut qpc = 0u64;
            if ep
                .capture
                .GetBuffer(
                    &mut data,
                    &mut frames,
                    &mut flags,
                    Some(&mut dev_pos),
                    Some(&mut qpc),
                )
                .is_err()
            {
                return;
            }
            if qpc_first.is_none() && qpc != 0 {
                *qpc_first = Some(qpc as i64);
            }

            let silent = (flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32) != 0;
            let n = frames as usize * ep.channels as usize;
            if silent || data.is_null() {
                out.extend(std::iter::repeat(0.0).take(frames as usize * CHANNELS as usize));
            } else if ep.float {
                let src = std::slice::from_raw_parts(data as *const f32, n);
                downmix(src, ep.channels, out);
            } else if ep.bits == 16 {
                let src = std::slice::from_raw_parts(data as *const i16, n);
                let tmp: Vec<f32> = src.iter().map(|s| *s as f32 / 32768.0).collect();
                downmix(&tmp, ep.channels, out);
            } else {
                out.extend(std::iter::repeat(0.0).take(frames as usize * CHANNELS as usize));
            }
            let _ = ep.capture.ReleaseBuffer(frames);
        }
    }

    /// Any channel layout ➜ interleaved stereo.
    fn downmix(src: &[f32], channels: u32, out: &mut Vec<f32>) {
        match channels {
            1 => {
                for s in src {
                    out.push(*s);
                    out.push(*s);
                }
            }
            2 => out.extend_from_slice(src),
            n => {
                let n = n as usize;
                for frame in src.chunks_exact(n) {
                    // L = FL + 0.707*C + 0.707*SL, R = FR + 0.707*C + 0.707*SR
                    let c = frame.get(2).copied().unwrap_or(0.0) * 0.707;
                    let l = frame[0] + c + frame.get(4).copied().unwrap_or(0.0) * 0.707;
                    let r = frame[1] + c + frame.get(5).copied().unwrap_or(0.0) * 0.707;
                    out.push(l.clamp(-1.0, 1.0));
                    out.push(r.clamp(-1.0, 1.0));
                }
            }
        }
    }

    /// Media Foundation AAC encoder MFT wrapper (PCM16 stereo 48 k ➜ AAC-LC).
    struct AacEncoder {
        transform: IMFTransform,
    }

    impl AacEncoder {
        unsafe fn new() -> windows::core::Result<Self> {
            let transform: IMFTransform = CoCreateInstance(
                &AACMFTEncoder,
                None,
                windows::Win32::System::Com::CLSCTX_INPROC_SERVER,
            )?;

            let in_type = MFCreateMediaType()?;
            in_type.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio)?;
            in_type.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_PCM)?;
            in_type.SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, SAMPLE_RATE)?;
            in_type.SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, CHANNELS)?;
            in_type.SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16)?;
            in_type.SetUINT32(&MF_MT_AUDIO_BLOCK_ALIGNMENT, CHANNELS * 2)?;
            in_type.SetUINT32(
                &MF_MT_AUDIO_AVG_BYTES_PER_SECOND,
                SAMPLE_RATE * CHANNELS * 2,
            )?;

            let out_type = MFCreateMediaType()?;
            out_type.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio)?;
            out_type.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_AAC)?;
            out_type.SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, SAMPLE_RATE)?;
            out_type.SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, CHANNELS)?;
            out_type.SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16)?;
            out_type.SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, AAC_BYTES_PER_SECOND)?;
            out_type.SetUINT32(&MF_MT_AAC_PAYLOAD_TYPE, 0)?;
            out_type.SetUINT32(&MF_MT_AAC_AUDIO_PROFILE_LEVEL_INDICATION, 0x29)?;

            transform.SetOutputType(0, &out_type, 0)?;
            transform.SetInputType(0, &in_type, 0)?;
            transform.ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0)?;
            transform.ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0)?;

            Ok(Self { transform })
        }

        unsafe fn encode(
            &self,
            pcm: &[i16],
            pts_hns: i64,
            mut sink: impl FnMut(Vec<u8>, i64, i64),
        ) -> windows::core::Result<()> {
            let bytes = pcm.len() * 2;
            let buffer = MFCreateMemoryBuffer(bytes as u32)?;
            let mut ptr: *mut u8 = std::ptr::null_mut();
            buffer.Lock(&mut ptr, None, None)?;
            std::ptr::copy_nonoverlapping(pcm.as_ptr() as *const u8, ptr, bytes);
            buffer.Unlock()?;
            buffer.SetCurrentLength(bytes as u32)?;

            let duration = (pcm.len() as i64 / CHANNELS as i64) * HNS_PER_SECOND
                / SAMPLE_RATE as i64;
            let sample = MFCreateSample()?;
            sample.AddBuffer(&buffer)?;
            sample.SetSampleTime(pts_hns)?;
            sample.SetSampleDuration(duration)?;
            self.transform.ProcessInput(0, &sample, 0)?;

            loop {
                let mut status = 0u32;
                let info = self.transform.GetOutputStreamInfo(0)?;
                let out_buffer = MFCreateMemoryBuffer(info.cbSize.max(4096))?;
                let out_sample = MFCreateSample()?;
                out_sample.AddBuffer(&out_buffer)?;

                let mut out = [MFT_OUTPUT_DATA_BUFFER {
                    dwStreamID: 0,
                    pSample: std::mem::ManuallyDrop::new(Some(out_sample.clone())),
                    dwStatus: 0,
                    pEvents: std::mem::ManuallyDrop::new(None),
                }];

                match self.transform.ProcessOutput(0, &mut out, &mut status) {
                    Ok(()) => {}
                    Err(e) if e.code() == MF_E_TRANSFORM_NEED_MORE_INPUT => return Ok(()),
                    Err(e) => return Err(e),
                }

                let t = out_sample.GetSampleTime().unwrap_or(pts_hns);
                let d = out_sample.GetSampleDuration().unwrap_or(duration);
                let contiguous = out_sample.ConvertToContiguousBuffer()?;
                let mut p: *mut u8 = std::ptr::null_mut();
                let mut cur = 0u32;
                contiguous.Lock(&mut p, None, Some(&mut cur))?;
                let payload = std::slice::from_raw_parts(p, cur as usize).to_vec();
                let _ = contiguous.Unlock();
                if !payload.is_empty() {
                    sink(payload, t, d);
                }
                let _ = std::mem::ManuallyDrop::take(&mut out[0].pSample);
            }
        }
    }

    pub(super) fn run(
        system: bool,
        mic: bool,
        stop: Arc<AtomicBool>,
        ring: Arc<Mutex<RollingRingBuffer>>,
        generation: Arc<AtomicU32>,
    ) {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            if MFStartup(MF_VERSION, MFSTARTUP_NOSOCKET).is_err() {
                CoUninitialize();
                return;
            }

            let loopback = if system {
                match open_endpoint(true) {
                    Ok(e) => Some(e),
                    Err(e) => {
                        log::warn!("[clipflow::audio] loopback endpoint failed: {e}");
                        None
                    }
                }
            } else {
                None
            };

            let microphone = if mic {
                match open_endpoint(false) {
                    Ok(e) => Some(e),
                    Err(e) => {
                        log::warn!("[clipflow::audio] mic endpoint failed: {e}");
                        None
                    }
                }
            } else {
                None
            };

            if loopback.is_none() && microphone.is_none() {
                let _ = MFShutdown();
                CoUninitialize();
                return;
            }

            let encoder = match AacEncoder::new() {
                Ok(e) => e,
                Err(e) => {
                    log::warn!("[clipflow::audio] AAC MFT unavailable: {e}");
                    let _ = MFShutdown();
                    CoUninitialize();
                    return;
                }
            };

            let mut freq = 0i64;
            let _ = QueryPerformanceFrequency(&mut freq);
            let mut origin = 0i64;
            let _ = QueryPerformanceCounter(&mut origin);
            let freq = if freq == 0 { HNS_PER_SECOND } else { freq };

            // AAC-LC frames are 1024 samples; feed the MFT in exact multiples.
            const FRAME_SAMPLES: usize = 1024 * CHANNELS as usize;
            let mut pending: Vec<f32> = Vec::with_capacity(FRAME_SAMPLES * 8);
            let mut mic_pending: Vec<f32> = Vec::with_capacity(FRAME_SAMPLES * 8);
            let mut pcm = Vec::<i16>::with_capacity(FRAME_SAMPLES);
            let mut samples_written: i64 = 0;
            let mut qpc_first: Option<i64> = None;

            while !stop.load(Ordering::Acquire) {
                if let Some(ep) = loopback.as_ref() {
                    drain_endpoint(ep, &mut pending, &mut qpc_first);
                }
                if let Some(ep) = microphone.as_ref() {
                    drain_endpoint(ep, &mut mic_pending, &mut qpc_first);
                }

                // Mix the mic in, sample-aligned, -3 dB per source.
                if !mic_pending.is_empty() {
                    if loopback.is_none() {
                        pending.append(&mut mic_pending);
                    } else {
                        let n = pending.len().min(mic_pending.len());
                        for i in 0..n {
                            pending[i] = (pending[i] * 0.707 + mic_pending[i] * 0.707)
                                .clamp(-1.0, 1.0);
                        }
                        mic_pending.drain(..n);
                        if mic_pending.len() > FRAME_SAMPLES * 16 {
                            mic_pending.clear(); // mic ran away: resync
                        }
                    }
                }

                let epoch = qpc_first.unwrap_or(origin);
                while pending.len() >= FRAME_SAMPLES {
                    pcm.clear();
                    pcm.extend(
                        pending
                            .drain(..FRAME_SAMPLES)
                            .map(|s| (s.clamp(-1.0, 1.0) * 32767.0) as i16),
                    );

                    let pts = ((epoch - origin) as i128 * HNS_PER_SECOND as i128 / freq as i128)
                        as i64
                        + samples_written * HNS_PER_SECOND / SAMPLE_RATE as i64;
                    samples_written += 1024;

                    let gen = generation.load(Ordering::Acquire);
                    let ring_ref = &ring;
                    let _ = encoder.encode(&pcm, pts, |payload, t, d| {
                        ring_ref.lock().push(EncodedPacket {
                            track: TrackKind::Audio,
                            data: Arc::from(payload.into_boxed_slice()),
                            pts_hns: t,
                            duration_hns: d,
                            keyframe: true,
                            generation: gen,
                        });
                    });
                }

                std::thread::sleep(std::time::Duration::from_millis(8));
            }

            if let Some(ep) = loopback.as_ref() {
                let _ = ep.client.Stop();
            }
            if let Some(ep) = microphone.as_ref() {
                let _ = ep.client.Stop();
            }
            let _ = MFShutdown();
            CoUninitialize();
        }
    }
}

// ---------------------------------------------------------------------------
// Non-Windows stub
// ---------------------------------------------------------------------------

#[cfg(any(not(windows), feature = "headless-sim"))]
mod imp {
    use super::*;

    pub(super) fn run(
        _system: bool,
        _mic: bool,
        stop: Arc<AtomicBool>,
        ring: Arc<Mutex<RollingRingBuffer>>,
        generation: Arc<AtomicU32>,
    ) {
        // 21.3 ms AAC frames of silence keep the muxer path exercised.
        let frame_hns = 1024 * HNS_PER_SECOND / SAMPLE_RATE as i64;
        let mut pts = 0i64;
        while !stop.load(Ordering::Acquire) {
            ring.lock().push(EncodedPacket {
                track: TrackKind::Audio,
                data: Arc::from(vec![0u8; 384].into_boxed_slice()),
                pts_hns: pts,
                duration_hns: frame_hns,
                keyframe: true,
                generation: generation.load(Ordering::Acquire),
            });
            pts += frame_hns;
            std::thread::sleep(std::time::Duration::from_millis(21));
        }
    }
}
