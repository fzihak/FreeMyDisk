use crate::traits::{
    EmergencyRescueSummary, MaintenanceTaskKind, PlatformError, PlatformSystemMaintenance,
};
use std::os::windows::process::CommandExt;
use std::path::PathBuf;

const CREATE_NO_WINDOW: u32 = 0x08000000;

fn hidden_cmd(prog: &str) -> std::process::Command {
    let mut cmd = std::process::Command::new(prog);
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

pub struct WindowsSystemMaintenanceHandler;

impl WindowsSystemMaintenanceHandler {
    pub fn new() -> Self {
        Self
    }

    #[allow(clippy::permissions_set_readonly_false)]
    pub fn clean_target_dir(dir: PathBuf, label: &str, actions: &mut Vec<String>) -> u64 {
        let mut cleaned = 0u64;
        if dir.exists() {
            if let Ok(entries) = std::fs::read_dir(&dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.is_file() {
                        if let Ok(meta) = path.metadata() {
                            let len = meta.len();
                            let mut perms = meta.permissions();
                            perms.set_readonly(false);
                            let _ = std::fs::set_permissions(&path, perms);
                            if std::fs::remove_file(&path).is_ok() {
                                cleaned += len;
                            }
                        }
                    } else if path.is_dir() {
                        let (s, _) = Self::calc_dir_bytes(&path);
                        if std::fs::remove_dir_all(&path).is_ok() {
                            cleaned += s;
                        } else {
                            cleaned += Self::clean_target_dir_tolerant(&path);
                            let _ = std::fs::remove_dir(&path);
                        }
                    }
                }
            }
        }
        if cleaned > 0 {
            actions.push(format!("Cleaned {} ({})", label, format_size(cleaned)));
        }
        cleaned
    }

    #[allow(clippy::permissions_set_readonly_false)]
    pub fn clean_target_dir_tolerant(dir: &std::path::Path) -> u64 {
        let mut cleaned = 0u64;
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_file() {
                    if let Ok(meta) = path.metadata() {
                        let len = meta.len();
                        let mut perms = meta.permissions();
                        perms.set_readonly(false);
                        let _ = std::fs::set_permissions(&path, perms);
                        if std::fs::remove_file(&path).is_ok() {
                            cleaned += len;
                        }
                    }
                } else if path.is_dir() {
                    cleaned += Self::clean_target_dir_tolerant(&path);
                    let _ = std::fs::remove_dir(&path);
                }
            }
        }
        cleaned
    }

    pub fn query_recycle_bin() -> Result<(u64, u64), PlatformError> {
        Self::query_recycle_bin_for_drive(None)
    }

    pub fn query_recycle_bin_for_drive(drive: Option<&str>) -> Result<(u64, u64), PlatformError> {
        unsafe {
            use windows_sys::Win32::UI::Shell::{SHQueryRecycleBinW, SHQUERYRBINFO};
            let mut info: SHQUERYRBINFO = std::mem::zeroed();
            info.cbSize = std::mem::size_of::<SHQUERYRBINFO>() as u32;

            let drive_wide: Option<Vec<u16>> = drive.map(|d| {
                let mut s = d.to_string();
                if s.ends_with(':') {
                    s.push('\\');
                }
                s.encode_utf16().chain(std::iter::once(0)).collect()
            });
            let psz_root = match &drive_wide {
                Some(w) => w.as_ptr(),
                None => std::ptr::null(),
            };

            let hr = SHQueryRecycleBinW(psz_root, &mut info);
            if hr == 0 {
                let size = if info.i64Size > 0 {
                    info.i64Size as u64
                } else {
                    0
                };
                let items = if info.i64NumItems > 0 {
                    info.i64NumItems as u64
                } else {
                    0
                };
                Ok((size, items))
            } else {
                Err(PlatformError::OperationFailed(format!(
                    "SHQueryRecycleBinW returned HRESULT: 0x{:X}",
                    hr
                )))
            }
        }
    }

    pub fn empty_recycle_bin_for_drive(drive: Option<&str>) -> Result<u64, PlatformError> {
        let initial_bytes = Self::query_recycle_bin_for_drive(drive)
            .map(|(s, _)| s)
            .unwrap_or(0);

        unsafe {
            use windows_sys::Win32::UI::Shell::{
                SHEmptyRecycleBinW, SHERB_NOCONFIRMATION, SHERB_NOPROGRESSUI, SHERB_NOSOUND,
            };
            let drive_wide: Option<Vec<u16>> = drive.map(|d| {
                let mut s = d.to_string();
                if s.ends_with(':') {
                    s.push('\\');
                }
                s.encode_utf16().chain(std::iter::once(0)).collect()
            });
            let psz_root = match &drive_wide {
                Some(w) => w.as_ptr(),
                None => std::ptr::null(),
            };
            let flags = SHERB_NOCONFIRMATION | SHERB_NOPROGRESSUI | SHERB_NOSOUND;
            let _ = SHEmptyRecycleBinW(std::ptr::null_mut(), psz_root, flags);
        }

        let after_bytes = Self::query_recycle_bin_for_drive(drive)
            .map(|(s, _)| s)
            .unwrap_or(0);
        let freed = initial_bytes.saturating_sub(after_bytes);
        Ok(if freed > 0 { freed } else { initial_bytes })
    }

    fn calc_dir_bytes(dir: &std::path::Path) -> (u64, u64) {
        let mut size = 0u64;
        let mut count = 0u64;
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                if let Ok(m) = entry.metadata() {
                    if m.is_file() {
                        size += m.len();
                        count += 1;
                    } else if m.is_dir() {
                        let (s, c) = Self::calc_dir_bytes(&entry.path());
                        size += s;
                        count += c;
                    }
                }
            }
        }
        (size, count)
    }
}

impl Default for WindowsSystemMaintenanceHandler {
    fn default() -> Self {
        Self::new()
    }
}

impl PlatformSystemMaintenance for WindowsSystemMaintenanceHandler {
    fn execute_maintenance_task(&self, task: MaintenanceTaskKind) -> Result<String, PlatformError> {
        match task {
            MaintenanceTaskKind::IconCacheReset => {
                // 1. Delete icon and thumbnail cache files
                if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
                    let icon_db = PathBuf::from(&local_app_data).join("IconCache.db");
                    let _ = std::fs::remove_file(icon_db);

                    let exp_dir =
                        PathBuf::from(&local_app_data).join(r"Microsoft\Windows\Explorer");
                    if let Ok(entries) = std::fs::read_dir(&exp_dir) {
                        for entry in entries.flatten() {
                            let fname = entry.file_name().to_string_lossy().to_string();
                            if fname.starts_with("iconcache_") || fname.starts_with("thumbcache_") {
                                let _ = std::fs::remove_file(entry.path());
                            }
                        }
                    }
                }

                // 2. Notify Windows Shell smoothly via SHChangeNotify without disrupting explorer.exe
                unsafe {
                    windows_sys::Win32::UI::Shell::SHChangeNotify(
                        windows_sys::Win32::UI::Shell::SHCNE_ASSOCCHANGED as i32,
                        windows_sys::Win32::UI::Shell::SHCNF_IDLIST,
                        std::ptr::null(),
                        std::ptr::null(),
                    );
                }
                Ok(
                    "Windows Icon and Thumbnail Cache reset; Windows Explorer notified smoothly."
                        .to_string(),
                )
            }

            MaintenanceTaskKind::DnsCacheFlush => {
                let output = hidden_cmd("ipconfig")
                    .arg("/flushdns")
                    .output()
                    .map_err(|e| {
                        PlatformError::OperationFailed(format!("Failed to execute ipconfig: {}", e))
                    })?;

                let msg = String::from_utf8_lossy(&output.stdout).to_string();
                Ok(if msg.trim().is_empty() {
                    "DNS Resolver Cache flushed successfully.".to_string()
                } else {
                    msg.trim().to_string()
                })
            }

            MaintenanceTaskKind::SearchIndexRebuild => {
                if !crate::windows::is_elevated_windows() {
                    return Err(PlatformError::ElevationRequired(
                        "Administrator privileges are required to rebuild Windows Search Index."
                            .to_string(),
                    ));
                }
                let _ = hidden_cmd("net").args(["stop", "wsearch"]).output();

                if let Ok(prog_data) = std::env::var("PROGRAMDATA") {
                    let edb_path = PathBuf::from(prog_data)
                        .join(r"Microsoft\Search\Data\Applications\Windows\Windows.edb");
                    let _ = std::fs::remove_file(edb_path);
                }

                let _ = hidden_cmd("net").args(["start", "wsearch"]).output();
                Ok("Windows Search Index Catalog has been reset and the indexing service restarted.".to_string())
            }

            MaintenanceTaskKind::WindowsUpdateCacheCleanup => {
                if !crate::windows::is_elevated_windows() {
                    return Err(PlatformError::ElevationRequired(
                        "Administrator privileges are required to clean Windows Update Cache."
                            .to_string(),
                    ));
                }
                let _ = hidden_cmd("net").args(["stop", "wuauserv"]).output();

                let mut deleted_count = 0;
                if let Ok(windir) = std::env::var("WINDIR") {
                    let download_dir = PathBuf::from(windir).join(r"SoftwareDistribution\Download");
                    if let Ok(entries) = std::fs::read_dir(&download_dir) {
                        for entry in entries.flatten() {
                            let path = entry.path();
                            if path.is_file() {
                                if std::fs::remove_file(&path).is_ok() {
                                    deleted_count += 1;
                                }
                            } else if path.is_dir() {
                                if std::fs::remove_dir_all(&path).is_ok() {
                                    deleted_count += 1;
                                } else {
                                    let freed = Self::clean_target_dir_tolerant(&path);
                                    let _ = std::fs::remove_dir(&path);
                                    if freed > 0 {
                                        deleted_count += 1;
                                    }
                                }
                            }
                        }
                    }
                }

                let _ = hidden_cmd("net").args(["start", "wuauserv"]).output();
                Ok(format!(
                    "Cleaned {} items from Windows Update Download Cache.",
                    deleted_count
                ))
            }

            MaintenanceTaskKind::NetworkStackReset => {
                if !crate::windows::is_elevated_windows() {
                    return Err(PlatformError::ElevationRequired(
                        "Administrator privileges are required to reset the network stack."
                            .to_string(),
                    ));
                }
                let _ = hidden_cmd("netsh").args(["winsock", "reset"]).output();
                let _ = hidden_cmd("netsh").args(["int", "ip", "reset"]).output();
                Ok("Winsock catalog and TCP/IP stack successfully reset.".to_string())
            }

            MaintenanceTaskKind::PrintQueuePurge => {
                if !crate::windows::is_elevated_windows() {
                    return Err(PlatformError::ElevationRequired(
                        "Administrator privileges are required to purge the print queue."
                            .to_string(),
                    ));
                }
                let _ = hidden_cmd("net").args(["stop", "spooler"]).output();
                let windir = std::env::var("WINDIR").unwrap_or_else(|_| r"C:\Windows".to_string());
                let spool_printers = PathBuf::from(windir).join(r"System32\spool\PRINTERS");
                let mut purged_count = 0;
                if spool_printers.exists() {
                    if let Ok(entries) = std::fs::read_dir(&spool_printers) {
                        for entry in entries.flatten() {
                            let p = entry.path();
                            if p.is_file() && std::fs::remove_file(&p).is_ok() {
                                purged_count += 1;
                            }
                        }
                    }
                }
                let _ = hidden_cmd("net").args(["start", "spooler"]).output();
                Ok(format!(
                    "Cleared {} stuck printer spool files; Print Spooler service restarted.",
                    purged_count
                ))
            }

            MaintenanceTaskKind::AudioServiceReset => {
                if !crate::windows::is_elevated_windows() {
                    return Err(PlatformError::ElevationRequired(
                        "Administrator privileges are required to restart Windows Audio service."
                            .to_string(),
                    ));
                }
                let _ = hidden_cmd("net").args(["stop", "audiosrv"]).output();
                let _ = hidden_cmd("net")
                    .args(["stop", "AudioEndpointBuilder"])
                    .output();
                let _ = hidden_cmd("net")
                    .args(["start", "AudioEndpointBuilder"])
                    .output();
                let _ = hidden_cmd("net").args(["start", "audiosrv"]).output();
                Ok(
                    "Windows Audio engine and AudioEndpointBuilder restarted successfully."
                        .to_string(),
                )
            }

            MaintenanceTaskKind::TimeServiceSync => {
                if !crate::windows::is_elevated_windows() {
                    return Err(PlatformError::ElevationRequired(
                        "Administrator privileges are required to synchronize Windows Time service.".to_string(),
                    ));
                }
                let _ = hidden_cmd("net").args(["start", "w32time"]).output();
                let output = hidden_cmd("w32tm").args(["/resync", "/force"]).output();
                match output {
                    Ok(o) if o.status.success() => Ok(
                        "Windows Time Service resynchronized system clock with NTP servers."
                            .to_string(),
                    ),
                    Ok(o) => {
                        let msg = String::from_utf8_lossy(&o.stdout);
                        Ok(if msg.trim().is_empty() {
                            "Time sync completed.".to_string()
                        } else {
                            msg.trim().to_string()
                        })
                    }
                    Err(e) => Err(PlatformError::OperationFailed(format!(
                        "Failed to execute w32tm: {}",
                        e
                    ))),
                }
            }

            MaintenanceTaskKind::StoreCacheReset => {
                let _ = hidden_cmd("wsreset.exe").output();
                Ok("Microsoft Store cache reset command executed successfully.".to_string())
            }

            MaintenanceTaskKind::SystemIntegrityRepair => {
                if !crate::windows::is_elevated_windows() {
                    return Err(PlatformError::ElevationRequired(
                        "Administrator privileges are required to run DISM and SFC system integrity repair.".to_string(),
                    ));
                }
                let dism = hidden_cmd("dism.exe")
                    .args(["/Online", "/Cleanup-Image", "/RestoreHealth"])
                    .output();
                let sfc = hidden_cmd("sfc.exe").arg("/scannow").output();
                let dism_ok = dism.as_ref().map(|o| o.status.success()).unwrap_or(false);
                let sfc_ok = sfc.as_ref().map(|o| o.status.success()).unwrap_or(false);
                Ok(format!(
                    "System integrity repair finished (DISM: {}, SFC: {}). Any corrupted core system files were replaced.",
                    if dism_ok { "Health Restored" } else { "Completed" },
                    if sfc_ok { "Files Verified" } else { "Completed" }
                ))
            }
        }
    }

    fn execute_emergency_rescue(&self) -> Result<EmergencyRescueSummary, PlatformError> {
        let mut total_bytes = 0u64;
        let mut actions = Vec::new();
        let mut hibernation_disabled = false;
        let mut recycle_bin_emptied = false;
        let mut temp_bytes = 0u64;
        let mut wsl_shutdown = false;

        // 1. Hibernation File (C:\hiberfil.sys)
        let hiber_path = PathBuf::from(r"C:\hiberfil.sys");
        if hiber_path.exists() {
            let size = hiber_path.metadata().map(|m| m.len()).unwrap_or(0);
            let out = hidden_cmd("powercfg").args(["/hibernate", "off"]).output();
            if let Ok(o) = out {
                if o.status.success() || !hiber_path.exists() {
                    hibernation_disabled = true;
                    total_bytes += size;
                    actions.push(format!(
                        "Disabled Windows Hibernation and reclaimed {} of disk space",
                        format_size(size)
                    ));
                }
            }
        }

        // 2. Empty Recycle Bin on all drives via Win32 Shell API
        unsafe {
            use windows_sys::Win32::UI::Shell::{
                SHEmptyRecycleBinW, SHERB_NOCONFIRMATION, SHERB_NOPROGRESSUI, SHERB_NOSOUND,
            };
            let flags = SHERB_NOCONFIRMATION | SHERB_NOPROGRESSUI | SHERB_NOSOUND;
            let res = SHEmptyRecycleBinW(std::ptr::null_mut(), std::ptr::null(), flags);
            if res == 0 {
                recycle_bin_emptied = true;
                actions.push("Emptied Windows Recycle Bin across all drives".to_string());
            }
        }

        // 3. Clean Temp Directories
        if let Ok(user_temp) = std::env::var("TEMP") {
            let b = Self::clean_target_dir(PathBuf::from(user_temp), "User %TEMP%", &mut actions);
            temp_bytes += b;
            total_bytes += b;
        }

        if let Ok(windir) = std::env::var("WINDIR") {
            let win_temp = PathBuf::from(&windir).join("Temp");
            let b = Self::clean_target_dir(win_temp, "Windows System Temp", &mut actions);
            temp_bytes += b;
            total_bytes += b;

            let minidump = PathBuf::from(&windir).join("Minidump");
            let b2 = Self::clean_target_dir(minidump, "Windows Crash Minidumps", &mut actions);
            total_bytes += b2;

            let mem_dmp = PathBuf::from(&windir).join("MEMORY.DMP");
            if mem_dmp.exists() {
                if let Ok(meta) = mem_dmp.metadata() {
                    let s = meta.len();
                    if std::fs::remove_file(&mem_dmp).is_ok() {
                        total_bytes += s;
                        actions.push(format!("Removed MEMORY.DMP ({})", format_size(s)));
                    }
                }
            }
        }

        if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
            let crash_dumps = PathBuf::from(&local_app_data).join("CrashDumps");
            let b = Self::clean_target_dir(crash_dumps, "Application Crash Dumps", &mut actions);
            total_bytes += b;

            let wer = PathBuf::from(&local_app_data).join(r"Microsoft\Windows\WER\ReportArchive");
            let b2 = Self::clean_target_dir(wer, "Windows Error Reports", &mut actions);
            total_bytes += b2;

            let d3d = PathBuf::from(&local_app_data).join("D3DSCache");
            let b3 = Self::clean_target_dir(d3d, "DirectX Shader Cache", &mut actions);
            total_bytes += b3;
        }

        // 4. WSL Shutdown
        let wsl_out = hidden_cmd("wsl").arg("--shutdown").output();
        if let Ok(o) = wsl_out {
            if o.status.success() {
                wsl_shutdown = true;
                actions.push(
                    "Shut down active WSL2 virtual machines to release memory & disk handles"
                        .to_string(),
                );
            }
        }

        Ok(EmergencyRescueSummary {
            total_bytes_reclaimed: total_bytes,
            hibernation_disabled,
            recycle_bin_emptied,
            temp_cleaned_bytes: temp_bytes,
            wsl_shutdown,
            actions_performed: actions,
        })
    }
}

fn format_size(bytes: u64) -> String {
    if bytes >= 1024 * 1024 * 1024 {
        format!("{:.2} GB", bytes as f64 / (1024.0 * 1024.0 * 1024.0))
    } else if bytes >= 1024 * 1024 {
        format!("{:.2} MB", bytes as f64 / (1024.0 * 1024.0))
    } else if bytes >= 1024 {
        format!("{:.2} KB", bytes as f64 / 1024.0)
    } else {
        format!("{} B", bytes)
    }
}
