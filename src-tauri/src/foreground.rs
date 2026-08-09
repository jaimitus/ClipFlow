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

/// Best-effort. Returns `None` when nothing is focused, the focused window is
/// our own deck, or the process handle cannot be queried (UAC, protected
/// process, race with the window closing...).
#[cfg(all(windows, not(feature = "headless-sim")))]
pub fn get_foreground_game() -> Option<ForegroundGame> {
    use windows::core::PWSTR;
    use windows::Win32::Foundation::{CloseHandle, HWND};
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowTextW, GetWindowThreadProcessId,
    };

    unsafe {
        let hwnd: HWND = GetForegroundWindow();
        if hwnd.is_invalid() {
            return None;
        }

        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == 0 {
            return None;
        }

        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;

        // QueryFullProcessImageNameW wants a fixed buffer; 1024 UTF-16 units
        // comfortably covers the 32k limit of MAX_PATH-extended paths.
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
            return None;
        }

        let mut title_buf = [0u16; 256];
        let title_len = GetWindowTextW(hwnd, &mut title_buf);
        let title = String::from_utf16_lossy(&title_buf[..title_len.max(0) as usize]);

        Some(ForegroundGame { exe, title })
    }
}

/// Headless-sim / non-Windows builds have no focus to inspect; the bridge's
/// browser fallback simulates a game cycling in the foreground instead.
#[cfg(any(not(windows), feature = "headless-sim"))]
pub fn get_foreground_game() -> Option<ForegroundGame> {
    None
}
