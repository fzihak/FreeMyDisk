use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PowerState {
    pub on_battery: bool,
    pub battery_saver_active: bool,
    pub battery_percentage: u8,
    pub ac_connected: bool,
    pub is_throttled: bool,
}

impl Default for PowerState {
    fn default() -> Self {
        Self {
            on_battery: false,
            battery_saver_active: false,
            battery_percentage: 100,
            ac_connected: true,
            is_throttled: false,
        }
    }
}

/// Queries Windows Power Management API for battery, AC status, and Battery Saver state.
#[cfg(target_os = "windows")]
pub fn get_system_power_state() -> PowerState {
    use windows_sys::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};

    let mut status = unsafe { std::mem::zeroed::<SYSTEM_POWER_STATUS>() };
    let success = unsafe { GetSystemPowerStatus(&mut status) != 0 };

    if !success {
        return PowerState::default();
    }

    // ACLineStatus: 0 = Offline (battery), 1 = Online (AC), 255 = Unknown
    let ac_connected = status.ACLineStatus == 1;
    let on_battery = status.ACLineStatus == 0;

    // BatteryLifePercent: 0-100, 255 = Unknown
    let battery_percentage = if status.BatteryLifePercent <= 100 {
        status.BatteryLifePercent
    } else {
        100
    };

    // SystemStatusFlag: 1 if Windows Battery Saver mode is currently active
    let battery_saver_active = status.SystemStatusFlag == 1;
    let is_throttled = on_battery || battery_saver_active;

    PowerState {
        on_battery,
        battery_saver_active,
        battery_percentage,
        ac_connected,
        is_throttled,
    }
}

#[cfg(not(target_os = "windows"))]
pub fn get_system_power_state() -> PowerState {
    PowerState::default()
}

/// Returns the optimal thread concurrency count based on AC vs battery state.
/// When running on battery or battery saver is active, clamps concurrency to at most 2 threads
/// to protect battery life and prevent thermal fan spin-up.
pub fn get_adaptive_concurrency_limit() -> usize {
    let power = get_system_power_state();
    if power.is_throttled {
        2
    } else {
        std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(4)
    }
}
