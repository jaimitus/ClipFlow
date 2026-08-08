//! Global shortcut registration.
//!
//! `Alt + C`       ➜ flush the rolling buffer to disk (the money shortcut)
//! `Alt + Shift+C` ➜ arm / disarm the buffer
//!
//! The handler must return in microseconds: it does nothing but kick a task on
//! the async runtime, otherwise Windows would consider the hook unresponsive
//! and silently unregister it mid-game.

use std::str::FromStr;
use std::sync::Arc;

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

use crate::commands::{AppState, EVT_ERROR, EVT_HOTKEY};

pub fn parse(accelerator: &str) -> Result<Shortcut, String> {
    Shortcut::from_str(accelerator)
        .map_err(|e| format!("invalid shortcut '{accelerator}': {e}"))
}

/// Registers both shortcuts. Called once from `setup`.
pub fn register_all(app: &AppHandle, save: &str, toggle: &str) -> Result<(), String> {
    let gs = app.global_shortcut();
    let save_sc = parse(save)?;
    let toggle_sc = parse(toggle)?;

    if !gs.is_registered(save_sc) {
        gs.register(save_sc)
            .map_err(|e| format!("could not register {save}: {e} (another app may own it)"))?;
    }
    if !gs.is_registered(toggle_sc) {
        gs.register(toggle_sc)
            .map_err(|e| format!("could not register {toggle}: {e}"))?;
    }
    Ok(())
}

pub fn rebind_save_hotkey(app: &AppHandle, previous: &str, next: &str) -> Result<(), String> {
    let gs = app.global_shortcut();
    if let Ok(prev) = parse(previous) {
        if gs.is_registered(prev) {
            let _ = gs.unregister(prev);
        }
    }
    let sc = parse(next)?;
    gs.register(sc)
        .map_err(|e| format!("could not register {next}: {e}"))
}

/// The single handler wired into the plugin builder.
pub fn on_shortcut(app: &AppHandle, shortcut: &Shortcut, state: ShortcutState) {
    if state != ShortcutState::Pressed {
        return;
    }

    let Some(app_state) = app.try_state::<AppState>() else {
        return;
    };
    let settings = app_state.settings.read().clone();

    let save_matches = parse(&settings.hotkey_save)
        .map(|s| &s == shortcut)
        .unwrap_or(false);
    let toggle_matches = parse(&settings.hotkey_toggle)
        .map(|s| &s == shortcut)
        .unwrap_or(false);

    if save_matches {
        let _ = app.emit(EVT_HOTKEY, settings.hotkey_save.clone());
        trigger_save(app.clone());
    } else if toggle_matches {
        let _ = app.emit(EVT_HOTKEY, settings.hotkey_toggle.clone());
        trigger_toggle(app.clone());
    }
}

/// Fire-and-forget flush. Never blocks the hook thread.
pub fn trigger_save(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let Some(state) = app.try_state::<AppState>() else {
            return;
        };

        let flush_lock = Arc::clone(&state.flush_lock);
        let engine = Arc::clone(&state.engine);
        if !engine.is_running() {
            let _ = app.emit(
                EVT_ERROR,
                "Buffer is not armed — press ARM BUFFER (or Alt+Shift+C) first.",
            );
            return;
        }

        let open_trimmer = state.settings.read().open_trimmer_after_save;
        let result = tauri::async_runtime::spawn_blocking(move || {
            let _guard = match flush_lock.try_lock() {
                Some(g) => g,
                None => {
                    return Err(crate::media::recorder::RecorderError::Other(
                        "Save replay already in progress".into(),
                    ))
                }
            };
            engine.flush_to_disk(None)
        })
        .await;

        match result {
            Ok(Ok(write)) => {
                let path = std::path::PathBuf::from(&write.path);
                let thumbnail = crate::media::library::extract_thumbnail(
                    &path,
                    (write.duration_seconds * 0.35).clamp(0.2, 6.0),
                )
                .ok();

                let clip = crate::media::library::ClipMetadata {
                    id: format!(
                        "{}-{}",
                        write.file_name,
                        chrono::Utc::now().timestamp_millis()
                    ),
                    path: write.path.clone(),
                    file_name: write.file_name.clone(),
                    title: write.file_name.trim_end_matches(".mp4").replace('_', " "),
                    duration_seconds: write.duration_seconds,
                    size_bytes: write.size_bytes,
                    created_unix_ms: chrono::Utc::now().timestamp_millis(),
                    width: write.width,
                    height: write.height,
                    fps: write.fps,
                    has_audio: write.has_audio,
                    thumbnail,
                };

                let _ = app.emit(
                    crate::commands::EVT_CLIP_SAVED,
                    crate::commands::ClipSavedPayload {
                        clip,
                        flush_ms: write.flush_ms,
                        triggered_by: "hotkey".into(),
                    },
                );

                if open_trimmer {
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = w.show();
                        let _ = w.unminimize();
                        let _ = w.set_focus();
                    }
                }
            }
            Ok(Err(e)) => {
                let _ = app.emit(EVT_ERROR, e.to_string());
            }
            Err(e) => {
                let _ = app.emit(EVT_ERROR, format!("flush task failed: {e}"));
            }
        }
    });
}

pub fn trigger_toggle(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let Some(state) = app.try_state::<AppState>() else {
            return;
        };
        let engine = Arc::clone(&state.engine);
        let cfg = state.settings.read().to_recorder_config();

        let stats = tauri::async_runtime::spawn_blocking(move || {
            if engine.is_running() {
                engine.stop();
            } else if let Err(e) = engine.start(cfg) {
                return Err(e.to_string());
            }
            Ok(engine.stats())
        })
        .await;

        match stats {
            Ok(Ok(s)) => {
                let _ = app.emit(crate::commands::EVT_BUFFER_STATE, s);
            }
            Ok(Err(e)) => {
                let _ = app.emit(EVT_ERROR, e);
            }
            Err(e) => {
                let _ = app.emit(EVT_ERROR, format!("toggle failed: {e}"));
            }
        }
    });
}
