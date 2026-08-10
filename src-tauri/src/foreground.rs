//! Foreground-window detection — powers the per-game capture profiles.
//!
//! Reads the executable of the window that currently owns focus. The UI polls
//! this at a low rate (2 s) and, when auto-switch is enabled, applies the
//! capture profile mapped to that game. The call is cheap (one window handle +
//! one process query) so a poll every couple of seconds costs nothing.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForegroundGame {
    /// Lowercase executable name, e.g. "cs2.exe".
    pub exe: String,
    /// Window title, e.g. "Counter-Strike 2".
    pub title: String,
}

/// Best-effort. Returns `None` only when nothing can be focused (lock screen,
/// UAC secure desktop) or the query genuinely fails — never as the normal
/// answer for a running game, see [`exe_name_for_pid`].
#[cfg(all(windows, not(feature = "headless-sim")))]
pub fn get_foreground_game() -> Option<ForegroundGame> {
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowTextW};
    let exe = foreground_exe()?;
    unsafe {
        let hwnd = GetForegroundWindow();
        let mut title_buf = [0u16; 256];
        let title_len = GetWindowTextW(hwnd, &mut title_buf);
        let title = String::from_utf16_lossy(&title_buf[..title_len.max(0) as usize]);
        Some(ForegroundGame { exe, title })
    }
}

/// Lowercase exe name of the foreground process, if any.
///
/// Title-less on purpose: it resolves the name via the process snapshot and
/// never calls `GetWindowTextW` (a cross-process message that blocks while a
/// hung app ignores it), so it is safe to call from the main thread — the
/// privacy gate in `update_settings` and the startup path use it for exactly
/// that reason.
#[cfg(all(windows, not(feature = "headless-sim")))]
pub fn foreground_exe() -> Option<String> {
    use windows::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowThreadProcessId,
    };
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.is_invalid() {
            return None;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == 0 {
            return None;
        }
        exe_name_for_pid(pid)
    }
}

/// Resolves the (lowercase) executable name for a PID.
///
/// Primary path: a `CreateToolhelp32Snapshot` process list. Snapshotting does
/// **not** open the target process, so it works for elevated games and
/// anti-cheat-protected processes that deny `OpenProcess` from a non-elevated
/// ClipFlow — the classic reason a game was never detected (and, before the
/// privacy-mode fix, why the deck showed "no game focused" mid-match). Falls
/// back to `OpenProcess` + `QueryFullProcessImageNameW` if the snapshot fails.
#[cfg(all(windows, not(feature = "headless-sim")))]
fn exe_name_for_pid(pid: u32) -> Option<String> {
    unsafe {
        use windows::Win32::Foundation::CloseHandle;
        use windows::Win32::System::Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
            TH32CS_SNAPPROCESS,
        };
        if let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) {
            let mut entry = PROCESSENTRY32W::default();
            entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
            let mut name: Option<String> = None;
            if Process32FirstW(snapshot, &mut entry).is_ok() {
                loop {
                    if entry.th32ProcessID == pid {
                        let raw = &entry.szExeFile;
                        let len = raw.iter().position(|&c| c == 0).unwrap_or(raw.len());
                        name = Some(String::from_utf16_lossy(&raw[..len]));
                        break;
                    }
                    if !Process32NextW(snapshot, &mut entry).is_ok() {
                        break;
                    }
                }
            }
            let _ = CloseHandle(snapshot);
            if let Some(n) = name {
                let trimmed = n.trim().to_ascii_lowercase();
                if !trimmed.is_empty() {
                    return Some(trimmed);
                }
            }
        }
    }

    // Fallback: classic handle-based path query.
    unsafe {
        use windows::core::PWSTR;
        use windows::Win32::Foundation::CloseHandle;
        use windows::Win32::System::Threading::{
            OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
            PROCESS_QUERY_LIMITED_INFORMATION,
        };
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let query = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            PWSTR(buf.as_mut_ptr()),
            &mut len,
        );
        let _ = CloseHandle(handle);
        if query.is_err() {
            return None;
        }
        let path = String::from_utf16_lossy(&buf[..len as usize]);
        let exe = path.rsplit('\\').next().unwrap_or("").to_ascii_lowercase();
        if exe.is_empty() {
            None
        } else {
            Some(exe)
        }
    }
}

/// Headless-sim / non-Windows builds have no focus to inspect; the bridge's
/// browser fallback simulates a game cycling in the foreground instead.
#[cfg(any(not(windows), feature = "headless-sim"))]
pub fn get_foreground_game() -> Option<ForegroundGame> {
    None
}

#[cfg(any(not(windows), feature = "headless-sim"))]
pub fn foreground_exe() -> Option<String> {
    None
}
