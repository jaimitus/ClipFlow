/**
 * TypeScript mirrors of the Rust structs in `src-tauri/src/media/*` and
 * `src-tauri/src/settings.rs`. Keep the two in sync — serde uses these exact
 * field names.
 */

export type EncoderVendor =
  | "nvenc"
  | "amd-amf"
  | "intel-qsv"
  | "media-foundation-software"
  | "unavailable";

export type EngineStateName =
  | "idle"
  | "starting"
  | "buffering"
  | "flushing"
  | "recovering"
  | "error";

export interface EncoderInfo {
  vendor: EncoderVendor;
  friendly_name: string;
  codec: string;
  hardware: boolean;
  adapter_name: string;
  dedicated_vram_mb: number;
}

export interface EngineStats {
  state: EngineStateName;
  encoder: EncoderInfo;
  width: number;
  height: number;
  target_fps: number;
  capture_fps: number;
  buffer_seconds: number;
  buffered_seconds: number;
  ring_bytes: number;
  ring_frames: number;
  process_rss_bytes: number;
  encode_ms_avg: number;
  gpu_submit_ms_avg: number;
  dropped_frames: number;
  device_resets: number;
  audio_system: boolean;
  audio_mic: boolean;
  audio_drift_ms: number;
  /** Why audio is missing (device in exclusive mode, AAC failure...), if any. */
  audio_error: string | null;
  /** Privacy mode: no game is focused, so capture is paused (ring empty). */
  privacy_active: boolean;
  uptime_seconds: number;
  last_error: string | null;
}

export interface ClipMetadata {
  id: string;
  path: string;
  file_name: string;
  title: string;
  duration_seconds: number;
  size_bytes: number;
  created_unix_ms: number;
  width: number;
  height: number;
  fps: number;
  has_audio: boolean;
  /** Per-game folder tag (e.g. "cs2"), null for clips at the output root. */
  game: string | null;
  thumbnail: string | null;
  /** Starred by the user (persisted in the local sidecar store). */
  favorite: boolean;
  /** User-added tags (persisted in the local sidecar store). */
  tags: string[];
  /** Browser-simulation only: object URL for the preview player. */
  preview_url?: string;
}

export interface TrimResult {
  path: string;
  file_name: string;
  duration_seconds: number;
  size_bytes: number;
  elapsed_ms: number;
  snapped_start_seconds: number;
}

/** Result of splitting a clip in two at the playhead. */
export interface SplitResult {
  partA: TrimResult;
  partB: TrimResult;
}

/** Result of a GIF export (the trimmer's EXPORT GIF button). */
export interface GifExportResult {
  path: string;
  file_name: string;
  width: number;
  height: number;
  frame_count: number;
  /** The frame rate the GIF actually plays at (100 / rounded delay). */
  fps: number;
  /** Real play duration in seconds (`frame_count * delay / 100`). */
  duration_seconds: number;
  size_bytes: number;
  elapsed_ms: number;
}

export interface ClipSavedPayload {
  clip: ClipMetadata;
  flushMs: number;
  triggeredBy: "hotkey" | "ui" | "tray" | string;
  /**
   * Whether the deck should open the trimmer. The Rust side sets this to
   * false when a hotkey save happens while a game has focus (raising the
   * deck would steal focus and minimise the game). Undefined = fall back to
   * the user's `openTrimmerAfterSave` setting (browser sim).
   */
  openTrimmer?: boolean;
}

export interface MonitorInfo {
  index: number;
  name: string;
  width: number;
  height: number;
  refresh_hz: number;
  primary: boolean;
  adapter: string;
}

export interface AppSettings {
  bufferSeconds: number;
  targetFps: number;
  bitrateKbps: number;
  codec: "h264" | "hevc";
  monitorIndex: number;
  captureSystemAudio: boolean;
  captureMicrophone: boolean;
  outputDir: string;
  hotkeySave: string;
  hotkeyToggle: string;
  openTrimmerAfterSave: boolean;
  minimizeToTray: boolean;
  autostartBuffer: boolean;
  playSaveSound: boolean;
  /** Pin the control deck above full-screen games. */
  alwaysOnTop: boolean;
  /** Per-game capture presets (ShadowPlay style). */
  profiles: CaptureProfile[];
  /** Foreground exe → profile mapping (auto-switch). */
  profileMap: ProfileMapEntry[];
  /** When on, the mapped profile follows the game that has focus. */
  autoSwitchProfiles: boolean;
  /** Launch ClipFlow hidden to tray at Windows sign-in. */
  launchAtStartup: boolean;
  /** Delete clips older than N days at launch (0 = keep everything). */
  autoCleanupDays: number;
  /** Save clips into per-game subfolders and tag them with the game. */
  organizeByGame: boolean;
  /** When the foreground game leaves focus, save its last 30 s automatically. */
  autosaveOnGameExit: boolean;
  /** Show the always-on-top recording indicator while armed. */
  hudEnabled: boolean;
  /**
   * Privacy mode: when no game has the foreground focus the buffer stops
   * accumulating (and is cleared), so clips can never contain desktop content.
   */
  privacyPauseWhenUnfocused: boolean;
  /** System (game) audio volume in the mix, 0-100. Applies live. */
  gameVolume: number;
  /** Microphone volume in the mix, 0-100. Applies live. */
  micVolume: number;
  /**
   * Adaptive capture (ECO): on battery or under memory pressure the deck
   * shrinks the rolling buffer live and caps the fps. Invisible when off.
   */
  adaptiveEco: boolean;
  /** Battery % at or below which ECO kicks in while on battery. */
  ecoBatteryThresholdPct: number;
  /** Free physical RAM (GiB) below which ECO kicks in. */
  ecoRamFreeGbs: number;
}

/** A point-in-time snapshot of the machine's power / memory state. */
export interface PowerState {
  /** True when running on battery (DC power). */
  onBattery: boolean;
  /** 0-100 remaining battery (100 when on AC or unknown). */
  batteryPercent: number;
  /** Available physical memory in bytes. */
  availableRamBytes: number;
  /** Total physical memory in bytes. */
  totalRamBytes: number;
}

/** One per-game capture preset. `id` is a stable slug like "competitivo". */
export interface CaptureProfile {
  id: string;
  name: string;
  bufferSeconds: number;
  targetFps: number;
  bitrateKbps: number;
  codec: "h264" | "hevc";
}

/** Maps a foreground executable (lowercase, e.g. "cs2.exe") to a profile. */
export interface ProfileMapEntry {
  profileId: string;
  exeName: string;
}

/** The window currently owning focus, as reported by the native backend. */
export interface ForegroundGame {
  exe: string;
  title: string;
}

/** Live download state surfaced by the auto-updater (About & Updates). */
export interface UpdateProgress {
  phase: "PENDING" | "DOWNLOADING" | "INSTALLING";
  downloaded: number;
  total: number;
}

export const VENDOR_LABEL: Record<EncoderVendor, string> = {
  nvenc: "NVIDIA NVENC",
  "amd-amf": "AMD AMF",
  "intel-qsv": "Intel Quick Sync",
  "media-foundation-software": "MF Software",
  unavailable: "Unavailable",
};

export const VENDOR_ACCENT: Record<EncoderVendor, string> = {
  nvenc: "#76ff9c",
  "amd-amf": "#ff5f6d",
  "intel-qsv": "#4fc3ff",
  "media-foundation-software": "#ffc94f",
  unavailable: "#8a8fa3",
};
