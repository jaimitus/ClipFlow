// ClipFlow — no console window in release; the tray icon is the UI anchor.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    clipflow_lib::run();
}
