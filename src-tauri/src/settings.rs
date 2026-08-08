//! User settings. Stored as a single JSON file next to the executable's
//! app-data folder. No cloud, no account, no telemetry - ClipFlow never opens
//! an outbound socket.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::media::recorder::{default_output_dir, Codec, RecorderConfig};

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
        }
    }
}

impl Settings {
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
