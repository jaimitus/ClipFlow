//! User settings. Stored as a single JSON file next to the executable's
//! app-data folder. No cloud, no account, no telemetry - ClipFlow never opens
//! an outbound socket.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::foreground;
use crate::media::recorder::{default_output_dir, Codec, RecorderConfig};

/// One per-game capture preset (ShadowPlay style). Applying a profile copies
/// its capture values into the global settings; the buffer window applies to
/// the running engine immediately, fps/bitrate/codec on the next engine start.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureProfile {
    /// Stable slug, e.g. "competitivo".
    pub id: String,
    pub name: String,
    pub buffer_seconds: u32,
    pub target_fps: u32,
    pub bitrate_kbps: u32,
    pub codec: Codec,
}

/// Maps a foreground executable to a profile. Keys on the exe name so the
/// match is exact and cheap (no fuzzy matching on window titles).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileMapEntry {
    pub profile_id: String,
    /// Lowercase executable name, e.g. "cs2.exe".
    pub exe_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub buffer_seconds: u32,
    pub target_fps: u32,
    pub bitrate_kbps: u32,
    pub codec: Codec,
    pub monitor_index: u32,
    pub capture_system_audio: bool,
    pub capture_microphone: bool,
    pub output_dir: String,
    pub hotkey_save: String,
    pub hotkey_toggle: String,
    pub open_trimmer_after_save: bool,
    pub minimize_to_tray: bool,
    pub autostart_buffer: bool,
    pub play_save_sound: bool,
    /// Keep the control deck pinned above full-screen games.
    #[serde(default)]
    pub always_on_top: bool,
    /// Per-game capture profiles. Seeded with three stock presets on first run.
    #[serde(default)]
    pub profiles: Vec<CaptureProfile>,
    /// Foreground exe → profile mapping (auto-switch).
    #[serde(default)]
    pub profile_map: Vec<ProfileMapEntry>,
    /// When true, the mapped profile follows the game that has focus.
    #[serde(default)]
    pub auto_switch_profiles: bool,
    /// Launch ClipFlow hidden to tray at Windows sign-in.
    #[serde(default)]
    pub launch_at_startup: bool,
    /// Delete clips older than N days at launch (0 = keep everything).
    #[serde(default)]
    pub auto_cleanup_days: u32,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            buffer_seconds: 60,
            target_fps: 60,
            bitrate_kbps: 12_000,
            codec: Codec::H264,
            monitor_index: 0,
            capture_system_audio: true,
            capture_microphone: false,
            output_dir: default_output_dir().to_string_lossy().to_string(),
            hotkey_save: "Alt+C".into(),
            hotkey_toggle: "Alt+Shift+C".into(),
            open_trimmer_after_save: true,
            minimize_to_tray: true,
            autostart_buffer: true,
            play_save_sound: true,
            always_on_top: false,
            profiles: Vec::new(),
            profile_map: Vec::new(),
            auto_switch_profiles: false,
            launch_at_startup: false,
            auto_cleanup_days: 0,
        }
    }
}

impl Settings {
    /// Seeds the three stock profiles on first run. The "default" one mirrors
    /// whatever the user's global capture settings currently are, so applying
    /// it later is a true "back to my baseline" action.
    pub fn seed_default_profiles(&mut self) {
        if !self.profiles.is_empty() {
            return;
        }
        self.profiles = vec![
            CaptureProfile {
                id: "default".into(),
                name: "Default".into(),
                buffer_seconds: self.buffer_seconds,
                target_fps: self.target_fps,
                bitrate_kbps: self.bitrate_kbps,
                codec: self.codec,
            },
            CaptureProfile {
                id: "competitivo".into(),
                name: "Competitivo".into(),
                buffer_seconds: 30,
                target_fps: 60,
                bitrate_kbps: 12_000,
                codec: Codec::H264,
            },
            CaptureProfile {
                id: "cine".into(),
                name: "Cine".into(),
                buffer_seconds: 120,
                target_fps: 60,
                bitrate_kbps: 25_000,
                codec: Codec::Hevc,
            },
        ];
    }

    pub fn profile_by_id(&self, id: &str) -> Option<&CaptureProfile> {
        self.profiles.iter().find(|p| p.id == id)
    }

    /// The profile mapped to `exe` (case-insensitive match), if any.
    pub fn profile_for_exe(&self, exe: &str) -> Option<&CaptureProfile> {
        let exe = exe.to_ascii_lowercase();
        self.profile_map
            .iter()
            .find(|m| m.exe_name.to_ascii_lowercase() == exe)
            .and_then(|m| self.profile_by_id(&m.profile_id))
    }

    /// The profile that should be live right now under auto-switch: the one
    /// mapped to the game currently in the foreground, if any.
    pub fn active_profile(&self) -> Option<&CaptureProfile> {
        if !self.auto_switch_profiles {
            return None;
        }
        let game = foreground::get_foreground_game()?;
        self.profile_for_exe(&game.exe)
    }

    /// Copies a profile's capture values into the global settings.
    pub fn apply_profile_values(&mut self, profile: &CaptureProfile) {
        self.buffer_seconds = profile.buffer_seconds.clamp(5, 600);
        self.target_fps = profile.target_fps.clamp(24, 240);
        self.bitrate_kbps = profile.bitrate_kbps.clamp(1_000, 150_000);
        self.codec = profile.codec;
    }

    /// RecorderConfig for a specific profile (used at launch when the
    /// auto-switch profile should be armed from the very first frame).
    pub fn to_profile_config(&self, profile: &CaptureProfile) -> RecorderConfig {
        let mut cfg = self.to_recorder_config();
        cfg.buffer_seconds = profile.buffer_seconds.clamp(5, 600);
        cfg.target_fps = profile.target_fps.clamp(24, 240);
        cfg.bitrate_kbps = profile.bitrate_kbps.clamp(1_000, 150_000);
        cfg.codec = profile.codec;
        cfg
    }

    pub fn to_recorder_config(&self) -> RecorderConfig {
        RecorderConfig {
            buffer_seconds: self.buffer_seconds.clamp(5, 600),
            target_fps: self.target_fps.clamp(24, 240),
            width: 0,
            height: 0,
            bitrate_kbps: self.bitrate_kbps.clamp(1_000, 150_000),
            codec: self.codec,
            monitor_index: self.monitor_index,
            capture_system_audio: self.capture_system_audio,
            capture_microphone: self.capture_microphone,
            output_dir: PathBuf::from(&self.output_dir),
        }
    }

    pub fn config_path() -> PathBuf {
        #[cfg(windows)]
        {
            if let Ok(appdata) = std::env::var("APPDATA") {
                return PathBuf::from(appdata).join("ClipFlow").join("settings.json");
            }
        }
        std::env::temp_dir().join("ClipFlow").join("settings.json")
    }

    pub fn load() -> Self {
        let path = Self::config_path();
        match std::fs::read_to_string(&path) {
            Ok(raw) => serde_json::from_str(&raw).unwrap_or_else(|e| {
                log::warn!("[clipflow] settings parse error ({e}); using defaults");
                Self::default()
            }),
            Err(_) => Self::default(),
        }
    }

    pub fn save(&self) -> Result<(), String> {
        let path = Self::config_path();
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let json = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        std::fs::write(&path, json).map_err(|e| e.to_string())
    }
}
