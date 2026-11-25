use crate::traits::{
    ExplorerSettings, HibernationInfo, PagingFileInfo, PlatformError, PlatformOptimization,
};
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use windows_sys::Win32::UI::Shell::{SHChangeNotify, SHCNE_ASSOCCHANGED, SHCNF_IDLIST};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    SendMessageTimeoutW, HWND_BROADCAST, SMTO_ABORTIFHUNG, WM_SETTINGCHANGE,
};
use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ};
use winreg::RegKey;

const CREATE_NO_WINDOW: u32 = 0x08000000;

fn broadcast_explorer_change(area: &str) {
    let mut area_wide = area.encode_utf16().collect::<Vec<_>>();
    area_wide.push(0);
    let mut result = 0_usize;
    unsafe {
        SendMessageTimeoutW(
            HWND_BROADCAST,
            WM_SETTINGCHANGE,
            0,
            area_wide.as_ptr() as isize,
            SMTO_ABORTIFHUNG,
            1_000,
            &mut result,
        );
        SHChangeNotify(
            SHCNE_ASSOCCHANGED as i32,
            SHCNF_IDLIST,
            std::ptr::null(),
            std::ptr::null(),
        );
    }
}

fn hidden_cmd(prog: &str) -> std::process::Command {
    let mut cmd = std::process::Command::new(prog);
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

pub struct WindowsOptimizationHandler;

impl WindowsOptimizationHandler {
    pub fn new() -> Self {
        Self
    }
}

impl Default for WindowsOptimizationHandler {
    fn default() -> Self {
        Self::new()
    }
}

impl PlatformOptimization for WindowsOptimizationHandler {
    fn get_hibernation_status(&self) -> Result<HibernationInfo, PlatformError> {
        let hiber_path = PathBuf::from(r"C:\hiberfil.sys");
        if hiber_path.exists() {
            let size = hiber_path.metadata().map(|m| m.len()).unwrap_or(0);
            Ok(HibernationInfo {
                enabled: true,
                file_path: Some(r"C:\hiberfil.sys".into()),
                file_size_bytes: Some(size),
            })
        } else {
            Ok(HibernationInfo {
                enabled: false,
                file_path: None,
                file_size_bytes: None,
            })
        }
    }

    fn set_hibernation_state(&self, enable: bool) -> Result<(), PlatformError> {
        let arg = if enable { "on" } else { "off" };

        if crate::windows::is_elevated_windows() {
            let output = hidden_cmd("powercfg")
                .args(["/hibernate", arg])
                .output()
                .map_err(|e| {
                    PlatformError::OperationFailed(format!("Failed to invoke powercfg: {}", e))
                })?;

            if !output.status.success() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                let stderr = String::from_utf8_lossy(&output.stderr);
                let err = format!("{} {}", stdout.trim(), stderr.trim())
                    .trim()
                    .to_string();
                let err_msg = if err.is_empty() {
                    "Windows powercfg returned an error code without details.".to_string()
                } else {
                    err
                };
                return Err(PlatformError::OperationFailed(format!(
                    "powercfg /hibernate {} failed: {}",
                    arg, err_msg
                )));
            }
            return Ok(());
        }

        // Seamless elevation fallback: invoke powercfg with UAC elevation
        let ps_cmd = format!(
            "Start-Process powercfg -ArgumentList '/hibernate {}' -Verb RunAs -Wait",
            arg
        );
        let output = hidden_cmd("powershell")
            .args(["-NoProfile", "-WindowStyle", "Hidden", "-Command", &ps_cmd])
            .output()
            .map_err(|e| {
                PlatformError::OperationFailed(format!("Elevation request failed: {}", e))
            })?;

        if !output.status.success() {
            return Err(PlatformError::ElevationRequired(
                "Administrator privileges were declined or failed to apply.".to_string(),
            ));
        }

        Ok(())
    }

    fn get_storage_sense_status(&self) -> Result<bool, PlatformError> {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        if let Ok(key) = hkcu.open_subkey_with_flags(
            r"Software\Microsoft\Windows\CurrentVersion\StorageSense\Parameters\StoragePolicy",
            KEY_READ,
        ) {
            let val: u32 = key.get_value("01").unwrap_or(0);
            Ok(val != 0)
        } else {
            Ok(false)
        }
    }

    fn set_storage_sense_state(&self, enable: bool) -> Result<(), PlatformError> {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let (key, _) = hkcu
            .create_subkey(
                r"Software\Microsoft\Windows\CurrentVersion\StorageSense\Parameters\StoragePolicy",
            )
            .map_err(PlatformError::Io)?;

        let val: u32 = if enable { 1 } else { 0 };
        key.set_value("01", &val).map_err(PlatformError::Io)?;

        Ok(())
    }

    fn clean_delivery_optimization_cache(&self) -> Result<u64, PlatformError> {
        if crate::windows::is_elevated_windows() {
            let _ = hidden_cmd("net").args(["stop", "dosvc"]).output();

            let mut deleted_bytes = 0u64;
            let windir = std::env::var("WINDIR").unwrap_or_else(|_| r"C:\Windows".to_string());
            let do_path = PathBuf::from(windir).join(r"SoftwareDistribution\DeliveryOptimization");

            if do_path.exists() {
                if let Ok(entries) = std::fs::read_dir(&do_path) {
                    for entry in entries.flatten() {
                        let path = entry.path();
                        if let Ok(meta) = path.metadata() {
                            if meta.is_file() {
                                deleted_bytes += meta.len();
                                let _ = std::fs::remove_file(&path);
                            } else if meta.is_dir() {
                                let _ = std::fs::remove_dir_all(&path);
                            }
                        }
                    }
                }
            }

            let _ = hidden_cmd("net").args(["start", "dosvc"]).output();
            return Ok(deleted_bytes);
        }

        // Seamless elevation fallback: invoke cleanup with UAC elevation
        let ps_cmd = "Start-Process powershell -ArgumentList '-NoProfile -Command net stop dosvc; Remove-Item -Path $env:WINDIR\\SoftwareDistribution\\DeliveryOptimization\\* -Recurse -Force -ErrorAction SilentlyContinue; net start dosvc' -Verb RunAs -Wait";
        let output = hidden_cmd("powershell")
            .args(["-NoProfile", "-WindowStyle", "Hidden", "-Command", ps_cmd])
            .output()
            .map_err(|e| {
                PlatformError::OperationFailed(format!("Elevation request failed: {}", e))
            })?;

        if !output.status.success() {
            return Err(PlatformError::ElevationRequired(
                "Administrator privileges were declined or failed to clean Delivery Optimization."
                    .to_string(),
            ));
        }
        Ok(0)
    }

    fn get_paging_file_info(&self) -> Result<PagingFileInfo, PlatformError> {
        let mut total_bytes = 0u64;
        let mut files = Vec::new();

        let candidates = [r"C:\pagefile.sys", r"C:\swapfile.sys"];
        for c in candidates {
            let p = PathBuf::from(c);
            if p.exists() {
                if let Ok(meta) = p.metadata() {
                    total_bytes += meta.len();
                    files.push(c.to_string());
                }
            }
        }

        Ok(PagingFileInfo {
            total_paging_bytes: total_bytes,
            paging_files: files,
        })
    }

    fn get_explorer_settings(&self) -> Result<ExplorerSettings, PlatformError> {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);

        let (show_file_extensions, show_hidden_files, launch_this_pc, show_seconds) =
            if let Ok(adv_key) = hkcu.open_subkey_with_flags(
                r"Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced",
                KEY_READ,
            ) {
                let hide_ext: u32 = adv_key.get_value("HideFileExt").unwrap_or(1);
                let hidden: u32 = adv_key.get_value("Hidden").unwrap_or(2);
                let launch_to: u32 = adv_key.get_value("LaunchTo").unwrap_or(2);
                let secs: u32 = adv_key.get_value("ShowSecondsInSystemClock").unwrap_or(0);
                (hide_ext == 0, hidden == 1, launch_to == 1, secs == 1)
            } else {
                (false, false, false, false)
            };

        let disable_bing_search = if let Ok(search_key) = hkcu.open_subkey_with_flags(
            r"Software\Microsoft\Windows\CurrentVersion\Search",
            KEY_READ,
        ) {
            let bing_enabled: u32 = search_key.get_value("BingSearchEnabled").unwrap_or(1);
            let disable_suggestions: u32 = search_key
                .get_value("DisableSearchBoxSuggestions")
                .unwrap_or(0);
            bing_enabled == 0 || disable_suggestions == 1
        } else {
            false
        };

        let classic_context_menu = hkcu
            .open_subkey(
                r"Software\Classes\CLSID\{86ca1aa0-34aa-4e8b-a509-50c905bae2a2}\InprocServer32",
            )
            .is_ok();

        let enable_end_task = if let Ok(tb_dev) = hkcu.open_subkey_with_flags(
            r"Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced\TaskbarDeveloperSettings",
            KEY_READ,
        ) {
            tb_dev.get_value::<u32, _>("TaskbarEndTask").unwrap_or(0) == 1
        } else {
            false
        };

        let disable_advertising_id = if let Ok(ad_key) = hkcu.open_subkey_with_flags(
            r"Software\Microsoft\Windows\CurrentVersion\AdvertisingInfo",
            KEY_READ,
        ) {
            ad_key.get_value::<u32, _>("Enabled").unwrap_or(1) == 0
        } else {
            false
        };

        let disable_activity_upload = if let Ok(priv_key) = hkcu.open_subkey_with_flags(
            r"Software\Microsoft\Windows\CurrentVersion\Privacy",
            KEY_READ,
        ) {
            priv_key
                .get_value::<u32, _>("UploadUserActivities")
                .unwrap_or(1)
                == 0
        } else {
            false
        };

        let enable_long_paths = if let Ok(hklm) = RegKey::predef(HKEY_LOCAL_MACHINE)
            .open_subkey_with_flags(r"SYSTEM\CurrentControlSet\Control\FileSystem", KEY_READ)
        {
            hklm.get_value::<u32, _>("LongPathsEnabled").unwrap_or(0) == 1
        } else {
            false
        };

        let reduce_menu_delay = if let Ok(desktop_key) =
            hkcu.open_subkey_with_flags(r"Control Panel\Desktop", KEY_READ)
        {
            let delay: String = desktop_key
                .get_value("MenuShowDelay")
                .unwrap_or_else(|_| "400".into());
            delay == "0" || delay.parse::<u32>().unwrap_or(400) <= 50
        } else {
            false
        };

        let disable_game_dvr =
            if let Ok(gstore) = hkcu.open_subkey_with_flags(r"System\GameConfigStore", KEY_READ) {
                gstore.get_value::<u32, _>("GameDVR_Enabled").unwrap_or(1) == 0
            } else {
                false
            };

        let disable_copilot = if let Ok(copilot_key) = hkcu.open_subkey_with_flags(
            r"Software\Policies\Microsoft\Windows\WindowsCopilot",
            KEY_READ,
        ) {
            copilot_key
                .get_value::<u32, _>("TurnOffWindowsCopilot")
                .unwrap_or(0)
                == 1
        } else {
            false
        };

        let disable_ntfs_last_access = if let Ok(hklm) = RegKey::predef(HKEY_LOCAL_MACHINE)
            .open_subkey_with_flags(r"SYSTEM\CurrentControlSet\Control\FileSystem", KEY_READ)
        {
            hklm.get_value::<u32, _>("NtfsDisableLastAccessUpdate")
                .unwrap_or(0)
                == 1
        } else {
            false
        };

        Ok(ExplorerSettings {
            show_file_extensions,
            show_hidden_files,
            launch_this_pc,
            disable_bing_search,
            classic_context_menu,
            enable_end_task,
            show_seconds,
            disable_advertising_id,
            disable_activity_upload,
            enable_long_paths,
            reduce_menu_delay,
            disable_game_dvr,
            disable_copilot,
            disable_ntfs_last_access,
        })
    }

    fn set_explorer_setting(&self, setting_key: &str, enable: bool) -> Result<(), PlatformError> {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        match setting_key {
            "show_file_extensions" | "showFileExtensions" => {
                let (key, _) = hkcu
                    .create_subkey(r"Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced")
                    .map_err(PlatformError::Io)?;
                let val: u32 = if enable { 0 } else { 1 };
                key.set_value("HideFileExt", &val)
                    .map_err(PlatformError::Io)?;
                broadcast_explorer_change("ShellState");
            }
            "show_hidden_files" | "showHiddenFiles" => {
                let (key, _) = hkcu
                    .create_subkey(r"Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced")
                    .map_err(PlatformError::Io)?;
                let val: u32 = if enable { 1 } else { 2 };
                key.set_value("Hidden", &val).map_err(PlatformError::Io)?;
                broadcast_explorer_change("ShellState");
            }
            "launch_this_pc" | "launchThisPc" => {
                let (key, _) = hkcu
                    .create_subkey(r"Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced")
                    .map_err(PlatformError::Io)?;
                let val: u32 = if enable { 1 } else { 2 };
                key.set_value("LaunchTo", &val).map_err(PlatformError::Io)?;
                broadcast_explorer_change("Policy");
            }
            "disable_bing_search" | "disableBingSearch" => {
                let (key, _) = hkcu
                    .create_subkey(r"Software\Microsoft\Windows\CurrentVersion\Search")
                    .map_err(PlatformError::Io)?;
                let bing_val: u32 = if enable { 0 } else { 1 };
                let sugg_val: u32 = if enable { 1 } else { 0 };
                key.set_value("BingSearchEnabled", &bing_val)
                    .map_err(PlatformError::Io)?;
                key.set_value("DisableSearchBoxSuggestions", &sugg_val)
                    .map_err(PlatformError::Io)?;
                broadcast_explorer_change("SearchBox");
            }
            "classic_context_menu" | "classicContextMenu" => {
                if enable {
                    let (key, _) = hkcu
                        .create_subkey(r"Software\Classes\CLSID\{86ca1aa0-34aa-4e8b-a509-50c905bae2a2}\InprocServer32")
                        .map_err(PlatformError::Io)?;
                    key.set_value("", &"").map_err(PlatformError::Io)?;
                } else {
                    let _ = hkcu.delete_subkey_all(
                        r"Software\Classes\CLSID\{86ca1aa0-34aa-4e8b-a509-50c905bae2a2}",
                    );
                }
                broadcast_explorer_change("ShellState");
            }
            "enable_end_task" | "enableEndTask" => {
                let (key, _) = hkcu
                    .create_subkey(r"Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced\TaskbarDeveloperSettings")
                    .map_err(PlatformError::Io)?;
                let val: u32 = if enable { 1 } else { 0 };
                key.set_value("TaskbarEndTask", &val)
                    .map_err(PlatformError::Io)?;
                broadcast_explorer_change("Policy");
            }
            "show_seconds" | "showSeconds" => {
                let (key, _) = hkcu
                    .create_subkey(r"Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced")
                    .map_err(PlatformError::Io)?;
                let val: u32 = if enable { 1 } else { 0 };
                key.set_value("ShowSecondsInSystemClock", &val)
                    .map_err(PlatformError::Io)?;
                broadcast_explorer_change("ShellState");
            }
            "disable_advertising_id" | "disableAdvertisingId" => {
                let (key, _) = hkcu
                    .create_subkey(r"Software\Microsoft\Windows\CurrentVersion\AdvertisingInfo")
                    .map_err(PlatformError::Io)?;
                let val: u32 = if enable { 0 } else { 1 };
                key.set_value("Enabled", &val).map_err(PlatformError::Io)?;
            }
            "disable_activity_upload" | "disableActivityUpload" => {
                let (key, _) = hkcu
                    .create_subkey(r"Software\Microsoft\Windows\CurrentVersion\Privacy")
                    .map_err(PlatformError::Io)?;
                let val: u32 = if enable { 0 } else { 1 };
                key.set_value("UploadUserActivities", &val)
                    .map_err(PlatformError::Io)?;
                key.set_value("PublishUserActivities", &val)
                    .map_err(PlatformError::Io)?;
            }
            "enable_long_paths" | "enableLongPaths" => {
                let val = if enable { "1" } else { "0" };
                let _ = hidden_cmd("reg")
                    .args([
                        "add",
                        r"HKLM\SYSTEM\CurrentControlSet\Control\FileSystem",
                        "/v",
                        "LongPathsEnabled",
                        "/t",
                        "REG_DWORD",
                        "/d",
                        val,
                        "/f",
                    ])
                    .status();
            }
            "reduce_menu_delay" | "reduceMenuDelay" => {
                let (key, _) = hkcu
                    .create_subkey(r"Control Panel\Desktop")
                    .map_err(PlatformError::Io)?;
                let val = if enable { "0" } else { "400" };
                key.set_value("MenuShowDelay", &val)
                    .map_err(PlatformError::Io)?;
                broadcast_explorer_change("ControlPanelDisplay");
            }
            "disable_game_dvr" | "disableGameDvr" => {
                let (key1, _) = hkcu
                    .create_subkey(r"System\GameConfigStore")
                    .map_err(PlatformError::Io)?;
                let dvr_val: u32 = if enable { 0 } else { 1 };
                key1.set_value("GameDVR_Enabled", &dvr_val)
                    .map_err(PlatformError::Io)?;

                let (key2, _) = hkcu
                    .create_subkey(r"Software\Microsoft\Windows\CurrentVersion\GameDVR")
                    .map_err(PlatformError::Io)?;
                let cap_val: u32 = if enable { 0 } else { 1 };
                key2.set_value("AppCaptureEnabled", &cap_val)
                    .map_err(PlatformError::Io)?;
            }
            "disable_copilot" | "disableCopilot" => {
                let (key, _) = hkcu
                    .create_subkey(r"Software\Policies\Microsoft\Windows\WindowsCopilot")
                    .map_err(PlatformError::Io)?;
                let val: u32 = if enable { 1 } else { 0 };
                key.set_value("TurnOffWindowsCopilot", &val)
                    .map_err(PlatformError::Io)?;
                broadcast_explorer_change("Policy");
            }
            "disable_ntfs_last_access" | "disableNtfsLastAccess" => {
                let val = if enable { "1" } else { "0" };
                let _ = hidden_cmd("reg")
                    .args([
                        "add",
                        r"HKLM\SYSTEM\CurrentControlSet\Control\FileSystem",
                        "/v",
                        "NtfsDisableLastAccessUpdate",
                        "/t",
                        "REG_DWORD",
                        "/d",
                        val,
                        "/f",
                    ])
                    .status();
            }
            unknown => {
                return Err(PlatformError::OperationFailed(format!(
                    "Unknown explorer setting key: {}",
                    unknown
                )));
            }
        }
        Ok(())
    }

    fn trim_process_working_set(&self) -> Result<(), PlatformError> {
        unsafe {
            let handle = windows_sys::Win32::System::Threading::GetCurrentProcess();
            windows_sys::Win32::System::ProcessStatus::EmptyWorkingSet(handle);
        }
        Ok(())
    }
}
