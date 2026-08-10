//! ClipFlow — zero-bloat instant replay for Windows.
//!
//! Tauri v2 application setup: tray icon, global shortcuts, the stats
//! heartbeat and the IPC surface.

pub mod clipmeta;
pub mod commands;
pub mod foreground;
pub mod hotkeys;
pub mod media;
pub mod settings;

use std::sync::Arc;
use std::time::Duration;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager, WindowEvent};
use tauri_plugin_global_shortcut::ShortcutState;

use commands::{AppState, EVT_STATS};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::Builder::from_env(
        env_logger::Env::default().default_filter_or("info,clipflow=debug"),
    )
    .format_timestamp_millis()
    .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_notification::init())
        // Optional "launch at Windows sign-in". Kept entirely native (Rust
        // calls only), so no extra JS surface or capability is needed.
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![]),
        ))
        // GitHub Releases auto-updater — check() / downloadAndInstall() are
        // driven from the UI; nothing runs in the background.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    hotkeys::on_shortcut(app, shortcut, event.state());
                })
                .build(),
        )
        // Second instance ⇒ just surface the existing window; ClipFlow is a
        // single-instance app by design (one buffer, one encoder session).
        .manage(AppState::new())
        .setup(|app| {
            let handle = app.handle().clone();

            build_tray(&handle)?;

            let (save_key, toggle_key, autostart, cfg) = {
                let state = handle.state::<AppState>();
                let s = state.settings.read();
                (
                    s.hotkey_save.clone(),
                    s.hotkey_toggle.clone(),
                    s.autostart_buffer,
                    // If auto-switch is on and the game already in the foreground
                    // maps to a profile, arm the buffer with that profile's
                    // capture values from frame zero.
                    s.active_profile()
                        .map(|p| s.to_profile_config(p))
                        .unwrap_or_else(|| s.to_recorder_config()),
                )
            };

            // Keep the Windows Run key in sync with the saved preference.
            {
                use tauri_plugin_autostart::ManagerExt;
                let want = handle.state::<AppState>().settings.read().launch_at_startup;
                let autostart = handle.autolaunch();
                let is_on = autostart.is_enabled().unwrap_or(false);
                if want && !is_on {
                    let _ = autostart.enable();
                } else if !want && is_on {
                    let _ = autostart.disable();
                }
            }

            if let Err(e) = hotkeys::register_all(&handle, &save_key, &toggle_key) {
                log::warn!("[clipflow] hotkey registration: {e}");
                let h = handle.clone();
                let msg = e.clone();
                tauri::async_runtime::spawn(async move {
                    // Give the webview a beat to attach its listeners.
                    tokio::time::sleep(Duration::from_millis(900)).await;
                    let _ = h.emit(commands::EVT_ERROR, msg);
                });
            }

            // Pinned window: honour the saved always-on-top preference.
            if let Some(w) = handle.get_webview_window("main") {
                let on_top = handle
                    .state::<AppState>()
                    .settings
                    .read()
                    .always_on_top;
                if on_top {
                    let _ = w.set_always_on_top(true);
                }
            }

            // Privacy mode starts gated when the deck or desktop is focused
            // (positively known), so the ring never accumulates desktop footage
            // before the UI's first 2 s foreground poll has a chance to run.
            if handle.state::<AppState>().settings.read().privacy_pause_when_unfocused {
                handle
                    .state::<AppState>()
                    .engine
                    .set_privacy_gate(commands::privacy_should_gate());
            }

            // Arm the buffer immediately so the very first Alt+C already has
            // history behind it.
            if autostart {
                let h = handle.clone();
                tauri::async_runtime::spawn(async move {
                    let state = h.state::<AppState>();
                    let engine = Arc::clone(&state.engine);
                    let result =
                        tauri::async_runtime::spawn_blocking(move || engine.start(cfg)).await;
                    match result {
                        Ok(Ok(stats)) => {
                            let _ = h.emit(commands::EVT_BUFFER_STATE, stats);
                        }
                        Ok(Err(e)) => {
                            let _ = h.emit(commands::EVT_ERROR, e.to_string());
                        }
                        Err(e) => {
                            let _ = h.emit(
                                commands::EVT_ERROR,
                                format!("autostart failed: {e}"),
                            );
                        }
                    }
                });
            }

            // Stats heartbeat: 4 Hz is enough for smooth gauges and costs
            // roughly nothing (one atomic read per field).
            let h = handle.clone();
            tauri::async_runtime::spawn(async move {
                let mut ticker = tokio::time::interval(Duration::from_millis(250));
                loop {
                    ticker.tick().await;
                    let Some(state) = h.try_state::<AppState>() else {
                        break;
                    };
                    let stats = state.engine.stats();
                    if h.emit(EVT_STATS, stats).is_err() {
                        break;
                    }
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let minimize = window
                    .app_handle()
                    .try_state::<AppState>()
                    .map(|s| s.settings.read().minimize_to_tray)
                    .unwrap_or(true);
                if minimize && window.label() == "main" {
                    // Closing the window must never kill the buffer.
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::start_replay_buffer,
            commands::stop_replay_buffer,
            commands::get_engine_stats,
            commands::set_buffer_seconds,
            commands::save_instant_replay,
            commands::get_recorded_clips,
            commands::get_clip_thumbnail,
            commands::trim_clip,
            commands::delete_clip,
            commands::delete_all_clips,
            commands::rename_clip,
            commands::extract_png_frame,
            commands::save_png_snapshot,
            commands::copy_clip_to_clipboard,
            commands::reveal_clip_in_folder,
            commands::open_output_folder,
            commands::open_clip_external,
            commands::read_clip_as_data_url,
            commands::get_settings,
            commands::update_settings,
            commands::get_monitors,
            commands::get_output_dir,
            commands::get_foreground_game,
            commands::get_profiles,
            commands::save_profile,
            commands::delete_profile,
            commands::set_profile_map,
            commands::apply_profile,
            commands::cleanup_old_clips,
            commands::set_clip_favorite,
            commands::set_clip_tags,
            commands::set_privacy_gate,
            commands::set_hud_visible,
            commands::set_save_hotkey,
            commands::set_toggle_hotkey,
            commands::open_releases_page,
            commands::show_main_window,
            commands::hide_main_window,
            commands::get_system_report,
            commands::quit_app,
            commands::simulate_device_loss,
        ])
        .build(tauri::generate_context!())
        .expect("error while building ClipFlow")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                if let Some(state) = app.try_state::<AppState>() {
                    state.engine.stop();
                }
            }
        });
}

/// Tray menu: everything you need mid-game without alt-tabbing.
fn build_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let save = MenuItem::with_id(app, "save", "Save replay\tAlt+C", true, None::<&str>)?;
    let last30 = MenuItem::with_id(app, "save30", "Save last 30 s", true, None::<&str>)?;
    let toggle = MenuItem::with_id(app, "toggle", "Arm / disarm buffer", true, None::<&str>)?;
    let show = MenuItem::with_id(app, "show", "Open ClipFlow Studio", true, None::<&str>)?;
    let folder = MenuItem::with_id(app, "folder", "Open clips folder", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit ClipFlow", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;

    let capture = Submenu::with_id_and_items(
        app,
        "capture",
        "Capture",
        true,
        &[&save, &last30, &toggle],
    )?;
    let menu = Menu::with_items(app, &[&capture, &sep, &show, &folder, &sep, &quit])?;

    let mut builder = TrayIconBuilder::with_id("clipflow-tray")
        .menu(&menu)
        .tooltip("ClipFlow — buffer armed (Alt + C)")
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "save" => hotkeys::trigger_save(app.clone()),
            "save30" => {
                let h = app.clone();
                tauri::async_runtime::spawn(async move {
                    let Some(state) = h.try_state::<AppState>() else {
                        return;
                    };
                    // Privacy mode: the ring is empty while no game is focused.
                    if let Some(msg) = commands::privacy_blocked_message(&state, None) {
                        let _ = h.emit(commands::EVT_ERROR, msg);
                        return;
                    }
                    let engine = Arc::clone(&state.engine);
                    let _ = tauri::async_runtime::spawn_blocking(move || {
                        engine.flush_to_disk(Some(30.0))
                    })
                    .await;
                });
            }
            "toggle" => hotkeys::trigger_toggle(app.clone()),
            "show" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.unminimize();
                    let _ = w.set_focus();
                }
            }
            "folder" => {
                use tauri_plugin_opener::OpenerExt;
                if let Some(state) = app.try_state::<AppState>() {
                    let dir = state.settings.read().output_dir.clone();
                    let _ = std::fs::create_dir_all(&dir);
                    let _ = app.opener().open_path(dir, None::<&str>);
                }
            }
            "quit" => {
                if let Some(state) = app.try_state::<AppState>() {
                    state.engine.stop();
                }
                std::process::exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            match event {
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    ..
                }
                | TrayIconEvent::DoubleClick {
                    button: MouseButton::Left,
                    ..
                } => {
                    let app = tray.app_handle();
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = w.show();
                        let _ = w.unminimize();
                        let _ = w.set_focus();
                    }
                }
                _ => {}
            }
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }
    builder.build(app)?;
    Ok(())
}

/// Re-exported so `main.rs` stays a one-liner and integration tests can drive
/// the shortcut handler directly.
pub use tauri_plugin_global_shortcut::ShortcutState as GlobalShortcutState;
const _: fn(ShortcutState) -> bool = |s| matches!(s, ShortcutState::Pressed);
