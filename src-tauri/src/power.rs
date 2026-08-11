//! Battery + RAM telemetry for adaptive capture (ECO mode).
//!
//! The deck polls this every few seconds and runs the pure `powerPolicy`
//! (TypeScript) over it: on battery or under memory pressure the rolling
//! buffer shrinks live and the fps cap drops, so ClipFlow disappears from the
//! system's radar exactly when it matters. Telemetry is local and ephemeral —
//! nothing is stored or sent anywhere.

use serde::Serialize;

/// A point-in-time snapshot of the machine's power / memory state.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PowerState {
    /// True when running on battery (DC power).
    pub on_battery: bool,
    /// 0-100 remaining battery (100 when on AC or unknown).
    pub battery_percent: u8,
    /// Available physical memory in bytes.
    pub available_ram_bytes: u64,
    /// Total physical memory in bytes.
    pub total_ram_bytes: u64,
}

pub fn read_power_state() -> Result<PowerState, String> {
    #[cfg(all(windows, not(feature = "headless-sim")))]
    {
        use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
        use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};

        let mut sps = SYSTEM_POWER_STATUS::default();
        unsafe {
            GetSystemPowerStatus(&mut sps).map_err(|e| format!("GetSystemPowerStatus: {e}"))?;
        }
        // ACLineStatus: 0 = battery (offline), 1 = AC (online), 255 = unknown.
        let on_battery = sps.ACLineStatus == 0;
        // BATTERY_PERCENTAGE_UNKNOWN (255) is treated as full so ECO never
        // trips on an unknown reading.
        let battery_percent = if sps.BatteryLifePercent == 255 {
            100
        } else {
            sps.BatteryLifePercent.min(100)
        };

        let mut mem = MEMORYSTATUSEX::default();
        mem.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
        unsafe {
            GlobalMemoryStatusEx(&mut mem).map_err(|e| format!("GlobalMemoryStatusEx: {e}"))?;
        }
        Ok(PowerState {
            on_battery,
            battery_percent,
            available_ram_bytes: mem.ullAvailPhys,
            total_ram_bytes: mem.ullTotalPhys,
        })
    }
    #[cfg(any(not(windows), feature = "headless-sim"))]
    {
        // Non-Windows / headless simulation: always on AC with plenty of RAM,
        // so ECO stays inert unless the browser harness injects a snapshot.
        Ok(PowerState {
            on_battery: false,
            battery_percent: 100,
            available_ram_bytes: 8 * 1024 * 1024 * 1024,
            total_ram_bytes: 16 * 1024 * 1024 * 1024,
        })
    }
}
