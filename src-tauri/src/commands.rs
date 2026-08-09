//! Every Tauri IPC handler lives here. Each one returns `Result<T, String>` so
//! the frontend gets a plain, user-presentable message instead of an HRESULT.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::foreground::ForegroundGame;
use crate::media::library::{self, ClipMetadata, TrimResult};
use crate::media::recorder::{
    enumerate_monitors, CaptureEngine, ClipWriteResult, Codec, EngineStats, MonitorInfo,
};
use crate::settings::{CaptureProfile, ProfileMapEntry, Settings};

// ---------------------------------------------------------------------------
// Shared application state
// ---------------------------------------------------------------------------

pub struct AppState {
    pub engine: Arc<CaptureEngine>,
    pub settings: RwLock<Settings>,
    /// Guards against two Alt+C flushes racing each other.
    pub flush_lock: Arc<parking_lot::Mutex<()>>,
}

impl AppState {
    pub fn new() -> Self {
        let mut settings = Settings::load();
        settings.seed_default_profiles();
        let _ = settings.save(); // persist the stock profiles once
        Self {
            engine: Arc::new(CaptureEngine::new()),
            settings: RwLock::new(settings),
            flush_lock: Arc::new(parking_lot::Mutex::new(())),
        }
    }

    pub fn output_dir(&self) -> PathBuf {
        PathBuf::from(self.settings.read().output_dir.clone())
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// Event payloads
// ---------------------------------------------------------------------------

pub const EVT_CLIP_SAVED: &str = "clipflow://clip-saved";
pub const EVT_STATS: &str = "clipflow://stats";
pub const EVT_ERROR: &str = "clipflow://error";
pub const EVT_HOTKEY: &str = "clipflow://hotkey";
pub const EVT_BUFFER_STATE: &str = "clipflow://buffer-state";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipSavedPayload {
    pub clip: ClipMetadata,
    pub flush_ms: f32,
    pub triggered_by: String,
}

// ---------------------------------------------------------------------------
// Buffer lifecycle
// ---------------------------------------------------------------------------

/// Initialises DXGI Desktop Duplication + the hardware encoder and starts
/// filling the in-memory ring buffer.
#[tauri::command]
pub async fn start_replay_buffer(
    state: State<'_, AppState>,
    app: AppHandle,
    buffer_seconds: u32,
    target_fps: u32,
) -> Result<EngineStats, String> {
    let mut cfg = {
        let mut s = state.settings.write();
        s.buffer_seconds = buffer_seconds.clamp(5, 600);
        s.target_fps = target_fps.clamp(24, 240);
        let _ = s.save();
        s.to_recorder_config()
    };
    std::fs::create_dir_all(&cfg.output_dir).map_err(|e| e.to_string())?;
    cfg.buffer_seconds = buffer_seconds.clamp(5, 600);
    cfg.target_fps = target_fps.clamp(24, 240);

    let engine = Arc::clone(&state.engine);
    let stats = tauri::async_runtime::spawn_blocking(move || engine.start(cfg))
        .await
        .map_err(|e| format!("engine task panicked: {e}"))?
        .map_err(|e| e.to_string())?;

    let _ = app.emit(EVT_BUFFER_STATE, &stats);
    Ok(stats)
}

#[tauri::command]
pub async fn stop_replay_buffer(
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<EngineStats, String> {
    let engine = Arc::clone(&state.engine);
    let stats = tauri::async_runtime::spawn_blocking(move || {
        engine.stop();
        engine.stats()
    })
    .await
    .map_err(|e| format!("engine task panicked: {e}"))?;

    let _ = app.emit(EVT_BUFFER_STATE, &stats);
    Ok(stats)
}

#[tauri::command]
pub fn get_engine_stats(state: State<'_, AppState>) -> Result<EngineStats, String> {
    Ok(state.engine.stats())
}

#[tauri::command]
pub fn set_buffer_seconds(state: State<'_, AppState>, seconds: u32) -> Result<(), String> {
    state.engine.set_buffer_seconds(seconds);
    let mut s = state.settings.write();
    s.buffer_seconds = seconds.clamp(5, 600);
    s.save()
}

// ---------------------------------------------------------------------------
// The Alt+C path
// ---------------------------------------------------------------------------

/// Sanitises a foreground exe into a safe per-game folder name. Returns `None`
/// for our own process so pressing Alt+C on the deck never creates a "clipflow"
/// folder.
fn game_folder_name(exe: &str) -> Option<String> {
    let exe = exe.to_ascii_lowercase();
    if exe.starts_with("clipflow") {
        return None;
    }
    let stem = match exe.rfind('.') {
        Some(i) if i > 0 => &exe[..i],
        _ => exe.as_str(),
    };
    let sanitized: String = stem
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_') {
                c
            } else {
                '-'
            }
        })
        .collect();
    let name = sanitized.trim_matches('-').to_string();
    if name.is_empty() {
        None
    } else {
        Some(name)
    }
}

/// Resolves the per-game subfolder for the next flush: the game in the
/// foreground, or `game_override` when the caller already knows the game (the
/// auto-save-on-game-exit flow). Returns `None` when per-game organisation is
/// off or no game applies — the clip then lands in the output root.
pub fn resolve_game_folder(state: &AppState, game_override: Option<&str>) -> Option<String> {
    let s = state.settings.read();
    if !s.organize_by_game {
        return None;
    }
    if let Some(g) = game_override {
        return game_folder_name(g);
    }
    crate::foreground::get_foreground_game().and_then(|g| game_folder_name(&g.exe))
}

/// Flushes the ring buffer to a finalised `.mp4`, then returns its metadata.
/// `max_seconds` lets the UI (or the tray menu) ask for "last 30 s" out of a
/// 120 s buffer without re-configuring the engine. `game_override` is used by
/// the auto-save-on-game-exit flow: the game that just lost focus is tagged
/// even though it is no longer the foreground process at flush time.
#[tauri::command]
pub async fn save_instant_replay(
    state: State<'_, AppState>,
    app: AppHandle,
    max_seconds: Option<f32>,
    triggered_by: Option<String>,
    game_override: Option<String>,
) -> Result<ClipMetadata, String> {
    // Per-game organisation: route the flush into output_dir/<game>/. The
    // subfolder is recomputed on every save so it can never go stale.
    let game_folder = resolve_game_folder(&state, game_override.as_deref());
    state.engine.set_output_subfolder(game_folder.clone());

    let engine = Arc::clone(&state.engine);
    let with_thumb = true;

    let result: ClipWriteResult = tauri::async_runtime::spawn_blocking(move || {
        engine.flush_to_disk(max_seconds).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("flush task panicked: {e}"))??;

    let path = PathBuf::from(&result.path);
    let thumbnail = if with_thumb {
        library::extract_thumbnail(&path, (result.duration_seconds * 0.35).clamp(0.2, 6.0)).ok()
    } else {
        None
    };

    let clip = ClipMetadata {
        id: format!("{}-{}", result.file_name, chrono::Utc::now().timestamp_millis()),
        path: result.path.clone(),
        file_name: result.file_name.clone(),
        title: result.file_name.trim_end_matches(".mp4").replace('_', " "),
        duration_seconds: result.duration_seconds,
        size_bytes: result.size_bytes,
        created_unix_ms: chrono::Utc::now().timestamp_millis(),
        width: result.width,
        height: result.height,
        fps: result.fps,
        has_audio: result.has_audio,
        game: game_folder.clone(),
        thumbnail,
    };

    let _ = app.emit(
        EVT_CLIP_SAVED,
        ClipSavedPayload {
            clip: clip.clone(),
            flush_ms: result.flush_ms,
            triggered_by: triggered_by.unwrap_or_else(|| "ui".into()),
        },
    );

    log::info!(
        "[clipflow] saved {} ({:.1}s, {:.1} MB) in {:.1} ms",
        clip.file_name,
        clip.duration_seconds,
        clip.size_bytes as f32 / 1_048_576.0,
        result.flush_ms
    );

    Ok(clip)
}

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn get_recorded_clips(
    state: State<'_, AppState>,
    with_thumbnails: Option<bool>,
) -> Result<Vec<ClipMetadata>, String> {
    let dir = state.output_dir();
    let thumbs = with_thumbnails.unwrap_or(true);
    tauri::async_runtime::spawn_blocking(move || {
        library::scan_directory(&dir, thumbs).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("scan task panicked: {e}"))?
}

#[tauri::command]
pub async fn get_clip_thumbnail(path: String, at_seconds: Option<f32>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        library::extract_thumbnail(Path::new(&path), at_seconds.unwrap_or(1.0))
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("thumbnail task panicked: {e}"))?
}

/// Lossless key-frame accurate cut. No re-encode, so a 60 s clip trims in
/// roughly the time it takes to copy the bytes.
#[tauri::command]
pub async fn trim_clip(
    source_path: String,
    start_time: f32,
    end_time: f32,
    overwrite: Option<bool>,
) -> Result<TrimResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let source = PathBuf::from(&source_path);
        let overwrite = overwrite.unwrap_or(false);
        let dest = if overwrite {
            source.with_extension("trim.tmp.mp4")
        } else {
            library::suggested_trim_path(&source)
        };

        let mut result = library::trim_stream_copy(&source, &dest, start_time, end_time)
            .map_err(|e| e.to_string())?;

        if overwrite {
            std::fs::rename(&dest, &source).map_err(|e| e.to_string())?;
            result.path = source.to_string_lossy().to_string();
            result.file_name = source
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();
        }
        Ok(result)
    })
    .await
    .map_err(|e| format!("trim task panicked: {e}"))?
}

#[tauri::command]
pub fn delete_clip(path: String) -> Result<(), String> {
    library::delete_clip(Path::new(&path)).map_err(|e| e.to_string())
}

/// Removes every recorded clip from the output folder. Returns how many were
/// deleted so the UI can toast a precise count.
#[tauri::command]
pub fn delete_all_clips(state: State<'_, AppState>) -> Result<u32, String> {
    let dir = state.output_dir();
    let clips = library::scan_directory(&dir, false).map_err(|e| e.to_string())?;
    let mut deleted = 0u32;
    for c in &clips {
        if library::delete_clip(Path::new(&c.path)).is_ok() {
            deleted += 1;
        }
    }
    Ok(deleted)
}

#[tauri::command]
pub fn rename_clip(path: String, new_name: String) -> Result<String, String> {
    let src = PathBuf::from(&path);
    let sanitized: String = new_name
        .chars()
        .filter(|c| !matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'))
        .collect();
    let name = if sanitized.to_ascii_lowercase().ends_with(".mp4") {
        sanitized
    } else {
        format!("{sanitized}.mp4")
    };
    let dest = src
        .parent()
        .ok_or_else(|| "clip has no parent directory".to_string())?
        .join(name);
    std::fs::rename(&src, &dest).map_err(|e| e.to_string())?;
    Ok(dest.to_string_lossy().to_string())
}

/// Puts the clip on the clipboard as a CF_HDROP file drop, which is what
/// Discord / Explorer / Slack / Teams paste handlers expect for a video.
#[tauri::command]
pub fn copy_clip_to_clipboard(path: String) -> Result<(), String> {
    clipboard::copy_file(Path::new(&path))
}

#[tauri::command]
pub fn reveal_clip_in_folder(app: AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .reveal_item_in_dir(&path)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn open_output_folder(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let dir = state.output_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    app.opener()
        .open_path(dir.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn open_clip_external(app: AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_path(path, None::<&str>)
        .map_err(|e| e.to_string())
}

/// Manual "check for updates" — just opens the GitHub Releases page. No
/// background updater, no telemetry: ClipFlow stays true to its privacy model.
#[tauri::command]
pub fn open_releases_page(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(
            "https://github.com/jaimitus/ClipFlow/releases",
            None::<&str>,
        )
        .map_err(|e| e.to_string())
}

/// Decodes one frame of a clip (hardware accelerated) into a full-resolution
/// PNG data URL — powers the "snapshot" button in the trimmer without ever
/// touching the webview's canvas (which asset-protocol media would taint).
#[tauri::command]
pub async fn extract_png_frame(
    path: String,
    at_seconds: Option<f32>,
    max_width: Option<u32>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        library::extract_frame_png(
            Path::new(&path),
            at_seconds.unwrap_or(0.0),
            max_width.unwrap_or(0),
        )
        .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("snapshot task panicked: {e}"))?
}

/// Writes a PNG (base64 data URL) into the ClipFlow output folder. Only accepts
/// valid PNG bytes so the webview can never write arbitrary files.
#[tauri::command]
pub fn save_png_snapshot(
    state: State<'_, AppState>,
    png_base64: String,
    base_name: String,
) -> Result<String, String> {
    use base64::Engine;
    let raw = png_base64.trim_start_matches("data:image/png;base64,");
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(raw)
        .map_err(|e| format!("invalid png data: {e}"))?;
    if bytes.len() < 8 || bytes[..8] != [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A] {
        return Err("payload is not a PNG image".into());
    }
    let sanitized: String = base_name
        .chars()
        .filter(|c| !matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'))
        .collect();
    let stem = if sanitized.is_empty() {
        "snapshot".to_string()
    } else {
        sanitized.trim_end_matches(".png").to_string()
    };
    let dir = state.output_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{stem}.png"));
    std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

/// Reads a clip into memory and returns it as a base64 data URL so the webview
/// can preview it without granting broad filesystem scope.
#[tauri::command]
pub async fn read_clip_as_data_url(path: String, max_bytes: Option<u64>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = PathBuf::from(&path);
        let len = std::fs::metadata(&p).map_err(|e| e.to_string())?.len();
        let cap = max_bytes.unwrap_or(256 * 1024 * 1024);
        if len > cap {
            return Err(format!(
                "clip is {:.0} MB which exceeds the {:.0} MB inline preview limit",
                len as f64 / 1_048_576.0,
                cap as f64 / 1_048_576.0
            ));
        }
        let bytes = std::fs::read(&p).map_err(|e| e.to_string())?;
        use base64::Engine;
        Ok(format!(
            "data:video/mp4;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(&bytes)
        ))
    })
    .await
    .map_err(|e| format!("read task panicked: {e}"))?
}

// ---------------------------------------------------------------------------
// Settings / system
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> Result<Settings, String> {
    Ok(state.settings.read().clone())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsPatch {
    pub buffer_seconds: Option<u32>,
    pub target_fps: Option<u32>,
    pub bitrate_kbps: Option<u32>,
    pub codec: Option<Codec>,
    pub monitor_index: Option<u32>,
    pub capture_system_audio: Option<bool>,
    pub capture_microphone: Option<bool>,
    pub output_dir: Option<String>,
    pub open_trimmer_after_save: Option<bool>,
    pub minimize_to_tray: Option<bool>,
    pub autostart_buffer: Option<bool>,
    pub play_save_sound: Option<bool>,
    pub hotkey_save: Option<String>,
    pub hotkey_toggle: Option<String>,
    pub always_on_top: Option<bool>,
    pub auto_switch_profiles: Option<bool>,
    pub launch_at_startup: Option<bool>,
    pub auto_cleanup_days: Option<u32>,
    pub organize_by_game: Option<bool>,
    pub autosave_on_game_exit: Option<bool>,
    pub hud_enabled: Option<bool>,
}

#[tauri::command]
pub fn update_settings(
    state: State<'_, AppState>,
    app: AppHandle,
    patch: SettingsPatch,
) -> Result<Settings, String> {
    let mut s = state.settings.write();

    // Hotkeys must be re-registered with the OS before we persist them — if
    // another app owns the combo the whole patch fails and nothing is written.
    // Conflicts are rejected up front so one combo can never drive both actions.
    if let (Some(a), Some(b)) = (patch.hotkey_save.as_ref(), patch.hotkey_toggle.as_ref()) {
        if a == b {
            return Err(format!(
                "save and arm/disarm hotkeys cannot share the same combo '{a}'"
            ));
        }
    }
    if let Some(v) = patch.hotkey_save.as_ref() {
        if v == &s.hotkey_toggle {
            return Err(format!("'{v}' is already used by the arm/disarm hotkey"));
        }
    }
    if let Some(v) = patch.hotkey_toggle.as_ref() {
        if v == &s.hotkey_save {
            return Err(format!("'{v}' is already used by the save hotkey"));
        }
    }
    if let Some(v) = patch.hotkey_save {
        crate::hotkeys::rebind(&app, &s.hotkey_save, &v)?;
        s.hotkey_save = v;
    }
    if let Some(v) = patch.hotkey_toggle {
        crate::hotkeys::rebind(&app, &s.hotkey_toggle, &v)?;
        s.hotkey_toggle = v;
    }

    if let Some(v) = patch.buffer_seconds {
        s.buffer_seconds = v.clamp(5, 600);
        state.engine.set_buffer_seconds(s.buffer_seconds);
    }
    if let Some(v) = patch.target_fps {
        s.target_fps = v.clamp(24, 240);
    }
    if let Some(v) = patch.bitrate_kbps {
        s.bitrate_kbps = v.clamp(1_000, 150_000);
    }
    if let Some(v) = patch.codec {
        s.codec = v;
    }
    if let Some(v) = patch.monitor_index {
        s.monitor_index = v;
    }
    if let Some(v) = patch.capture_system_audio {
        s.capture_system_audio = v;
    }
    if let Some(v) = patch.capture_microphone {
        s.capture_microphone = v;
    }
    if let Some(v) = patch.output_dir {
        std::fs::create_dir_all(&v).map_err(|e| e.to_string())?;
        // Point the running engine at the new folder so the next Alt+C flush
        // lands where the gallery is scanning — no restart required.
        state.engine.set_output_dir(std::path::PathBuf::from(&v));
        s.output_dir = v;
    }
    if let Some(v) = patch.open_trimmer_after_save {
        s.open_trimmer_after_save = v;
    }
    if let Some(v) = patch.minimize_to_tray {
        s.minimize_to_tray = v;
    }
    if let Some(v) = patch.autostart_buffer {
        s.autostart_buffer = v;
    }
    if let Some(v) = patch.play_save_sound {
        s.play_save_sound = v;
    }
    if let Some(v) = patch.always_on_top {
        s.always_on_top = v;
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.set_always_on_top(v);
        }
    }
    if let Some(v) = patch.auto_switch_profiles {
        s.auto_switch_profiles = v;
    }
    if let Some(v) = patch.launch_at_startup {
        // Registry Run key lives with the OS; keep it in sync with the setting
        // so a corrupt settings.json can never leave an unwanted autostart.
        s.launch_at_startup = v;
        use tauri_plugin_autostart::ManagerExt;
        if v {
            if let Err(e) = app.autolaunch().enable() {
                return Err(format!("could not enable launch at startup: {e}"));
            }
        } else if let Err(e) = app.autolaunch().disable() {
            return Err(format!("could not disable launch at startup: {e}"));
        }
    }
    if let Some(v) = patch.auto_cleanup_days {
        s.auto_cleanup_days = v;
    }
    if let Some(v) = patch.organize_by_game {
        s.organize_by_game = v;
    }
    if let Some(v) = patch.autosave_on_game_exit {
        s.autosave_on_game_exit = v;
    }
    if let Some(v) = patch.hud_enabled {
        s.hud_enabled = v;
        if let Some(hud) = app.get_webview_window("hud") {
            if v {
                let _ = hud.show();
            } else {
                let _ = hud.hide();
            }
        }
    }
    s.save()?;
    Ok(s.clone())
}

/// Shows / hides the always-on-top recording HUD window. While showing, it is
/// anchored to the bottom-right corner of the main deck window (the HUD has no
/// chrome and ignores cursor events, so it never steals focus or clicks).
#[tauri::command]
pub fn set_hud_visible(app: AppHandle, visible: bool) -> Result<(), String> {
    const HUD_W: i32 = 190;
    const HUD_H: i32 = 44;
    let Some(hud) = app.get_webview_window("hud") else {
        return Ok(());
    };
    if !visible {
        let _ = hud.hide();
        return Ok(());
    }
    if let Some(main) = app.get_webview_window("main") {
        if let (Ok(size), Ok(pos)) = (main.inner_size(), main.outer_position()) {
            let x = pos.x as i32 + size.width as i32 - HUD_W - 18;
            let y = pos.y as i32 + size.height as i32 - HUD_H - 18;
            let _ = hud.set_position(tauri::PhysicalPosition::new(x.max(0), y.max(0)));
        }
    }
    // The HUD is a passive indicator: never grab focus or clicks.
    let _ = hud.set_ignore_cursor_events(true);
    let _ = hud.set_always_on_top(true);
    let _ = hud.show();
    Ok(())
}

/// Deletes clips older than `days` from the output folder. Returns how many
/// were removed so the UI can toast an exact count. Runs off the main thread.
#[tauri::command]
pub async fn cleanup_old_clips(state: State<'_, AppState>, days: u32) -> Result<u32, String> {
    let dir = state.output_dir();
    let days = days.max(1);
    let cutoff = chrono::Utc::now() - chrono::Duration::days(days as i64);
    tauri::async_runtime::spawn_blocking(move || {
        let clips = library::scan_directory(&dir, false).map_err(|e| e.to_string())?;
        let mut deleted = 0u32;
        for c in &clips {
            let created = chrono::DateTime::from_timestamp_millis(c.created_unix_ms as i64);
            if let Some(created) = created {
                if created < cutoff && library::delete_clip(Path::new(&c.path)).is_ok() {
                    deleted += 1;
                }
            }
        }
        Ok(deleted)
    })
    .await
    .map_err(|e| format!("cleanup task panicked: {e}"))?
}

// ---------------------------------------------------------------------------
// Capture profiles (per-game presets)
// ---------------------------------------------------------------------------

/// The game currently in the foreground, if any. The UI polls this at ~2 Hz
/// to drive profile auto-switching. Runs off the main thread because
/// `GetWindowTextW` sends a cross-process message that can block while a
/// hung foreground app ignores it.
#[tauri::command]
pub async fn get_foreground_game() -> Result<Option<ForegroundGame>, String> {
    tauri::async_runtime::spawn_blocking(crate::foreground::get_foreground_game)
        .await
        .map_err(|e| format!("foreground query panicked: {e}"))
}

#[tauri::command]
pub fn get_profiles(state: State<'_, AppState>) -> Result<Vec<CaptureProfile>, String> {
    Ok(state.settings.read().profiles.clone())
}

/// Creates or updates a profile (matched by `id`). Returns the full settings
/// so the UI can re-render from a single source of truth.
#[tauri::command]
pub fn save_profile(
    state: State<'_, AppState>,
    profile: CaptureProfile,
) -> Result<Settings, String> {
    let mut s = state.settings.write();
    let id = profile.id.trim().to_ascii_lowercase();
    if id.is_empty() {
        return Err("profile id cannot be empty".into());
    }
    let mut profile = profile;
    profile.id = id.clone();
    if profile.name.trim().is_empty() {
        profile.name = id.clone();
    } else {
        profile.name = profile.name.trim().to_string();
    }
    profile.buffer_seconds = profile.buffer_seconds.clamp(5, 600);
    profile.target_fps = profile.target_fps.clamp(24, 240);
    profile.bitrate_kbps = profile.bitrate_kbps.clamp(1_000, 150_000);

    if let Some(existing) = s.profiles.iter_mut().find(|p| p.id == id) {
        *existing = profile;
    } else {
        s.profiles.push(profile);
    }
    s.save()?;
    Ok(s.clone())
}

/// Removes a profile and any mappings that pointed at it.
#[tauri::command]
pub fn delete_profile(
    state: State<'_, AppState>,
    profile_id: String,
) -> Result<Settings, String> {
    let mut s = state.settings.write();
    let before = s.profiles.len();
    s.profiles.retain(|p| p.id != profile_id);
    if s.profiles.len() == before {
        return Err(format!("profile '{profile_id}' not found"));
    }
    s.profile_map.retain(|m| m.profile_id != profile_id);
    s.save()?;
    Ok(s.clone())
}

/// Replaces the whole exe → profile map. Rows with empty exes or unknown
/// profile ids are dropped; duplicate exes keep the first entry.
#[tauri::command]
pub fn set_profile_map(
    state: State<'_, AppState>,
    map: Vec<ProfileMapEntry>,
) -> Result<Settings, String> {
    let mut s = state.settings.write();
    let mut seen = std::collections::HashSet::new();
    let cleaned: Vec<ProfileMapEntry> = map
        .into_iter()
        .filter_map(|m| {
            let exe = m.exe_name.trim().to_ascii_lowercase();
            if exe.is_empty() || s.profile_by_id(&m.profile_id).is_none() {
                return None;
            }
            if !seen.insert(exe.clone()) {
                return None;
            }
            Some(ProfileMapEntry {
                profile_id: m.profile_id,
                exe_name: exe,
            })
        })
        .collect();
    s.profile_map = cleaned;
    s.save()?;
    Ok(s.clone())
}

/// Applies a profile right now: the buffer window changes live on the running
/// engine, fps/bitrate/codec are persisted and take effect on the next engine
/// start (same contract as the APPLY & RESTART ENGINE button).
#[tauri::command]
pub fn apply_profile(
    state: State<'_, AppState>,
    profile_id: String,
) -> Result<Settings, String> {
    let mut s = state.settings.write();
    let profile = s
        .profile_by_id(&profile_id)
        .cloned()
        .ok_or_else(|| format!("profile '{profile_id}' not found"))?;
    s.apply_profile_values(&profile);
    state.engine.set_buffer_seconds(s.buffer_seconds);
    s.save()?;
    Ok(s.clone())
}

#[tauri::command]
pub fn get_monitors() -> Result<Vec<MonitorInfo>, String> {
    Ok(enumerate_monitors())
}

#[tauri::command]
pub fn get_output_dir(state: State<'_, AppState>) -> Result<String, String> {
    Ok(state.settings.read().output_dir.clone())
}

/// Re-registers the save hotkey at runtime (kept for API symmetry; the UI goes
/// through `update_settings` so save + toggle rebind through the same path).
#[tauri::command]
pub fn set_save_hotkey(
    app: AppHandle,
    state: State<'_, AppState>,
    accelerator: String,
) -> Result<String, String> {
    let previous = state.settings.read().hotkey_save.clone();
    crate::hotkeys::rebind(&app, &previous, &accelerator)?;
    let mut s = state.settings.write();
    s.hotkey_save = accelerator.clone();
    s.save()?;
    Ok(accelerator)
}

/// Re-registers the arm/disarm hotkey at runtime.
#[tauri::command]
pub fn set_toggle_hotkey(
    app: AppHandle,
    state: State<'_, AppState>,
    accelerator: String,
) -> Result<String, String> {
    let previous = state.settings.read().hotkey_toggle.clone();
    crate::hotkeys::rebind(&app, &previous, &accelerator)?;
    let mut s = state.settings.write();
    s.hotkey_toggle = accelerator.clone();
    s.save()?;
    Ok(accelerator)
}

#[tauri::command]
pub fn show_main_window(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
    Ok(())
}

#[tauri::command]
pub fn hide_main_window(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
    Ok(())
}

#[tauri::command]
pub fn quit_app(state: State<'_, AppState>) -> Result<(), String> {
    state.engine.stop();
    std::process::exit(0);
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemReport {
    pub os: String,
    pub app_version: String,
    pub process_rss_bytes: u64,
    pub output_dir: String,
    pub monitors: Vec<MonitorInfo>,
}

#[tauri::command]
pub fn get_system_report(state: State<'_, AppState>) -> Result<SystemReport, String> {
    Ok(SystemReport {
        os: std::env::consts::OS.to_string(),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        process_rss_bytes: crate::media::recorder::process_rss_bytes(),
        output_dir: state.settings.read().output_dir.clone(),
        monitors: enumerate_monitors(),
    })
}

// ---------------------------------------------------------------------------
// Clipboard (CF_HDROP)
// ---------------------------------------------------------------------------

mod clipboard {
    use std::path::Path;

    #[cfg(all(windows, not(feature = "headless-sim")))]
    pub fn copy_file(path: &Path) -> Result<(), String> {
        use std::os::windows::ffi::OsStrExt;
        use windows::Win32::Foundation::HANDLE;
        use windows::Win32::System::DataExchange::{
            CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData,
        };
        use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
        use windows::Win32::System::Ole::CF_HDROP;
        use windows::Win32::UI::Shell::DROPFILES;

        if !path.exists() {
            return Err(format!("clip not found: {}", path.display()));
        }

        // Double-NUL terminated wide file list, as required by DROPFILES.
        let mut wide: Vec<u16> = path.as_os_str().encode_wide().collect();
        wide.push(0);
        wide.push(0);

        let header = std::mem::size_of::<DROPFILES>();
        let total = header + wide.len() * 2;

        unsafe {
            OpenClipboard(None).map_err(|e| format!("OpenClipboard: {e}"))?;
            let result = (|| -> Result<(), String> {
                EmptyClipboard().map_err(|e| format!("EmptyClipboard: {e}"))?;
                let hmem =
                    GlobalAlloc(GMEM_MOVEABLE, total).map_err(|e| format!("GlobalAlloc: {e}"))?;
                let ptr = GlobalLock(hmem);
                if ptr.is_null() {
                    return Err("GlobalLock returned null".into());
                }
                std::ptr::write_bytes(ptr as *mut u8, 0, total);
                let df = ptr as *mut DROPFILES;
                (*df).pFiles = header as u32;
                (*df).fWide = true.into();
                std::ptr::copy_nonoverlapping(
                    wide.as_ptr(),
                    (ptr as *mut u8).add(header) as *mut u16,
                    wide.len(),
                );
                let _ = GlobalUnlock(hmem);
                SetClipboardData(CF_HDROP.0 as u32, HANDLE(hmem.0))
                    .map_err(|e| format!("SetClipboardData: {e}"))?;
                Ok(())
            })();
            let _ = CloseClipboard();
            result
        }
    }

    #[cfg(any(not(windows), feature = "headless-sim"))]
    pub fn copy_file(path: &Path) -> Result<(), String> {
        if !path.exists() {
            return Err(format!("clip not found: {}", path.display()));
        }
        log::info!("[clipflow] (stub) copied {} to clipboard", path.display());
        Ok(())
    }
}

#[tauri::command]
pub fn simulate_device_loss(state: State<'_, AppState>) {
    state.engine.simulate_device_loss();
}
