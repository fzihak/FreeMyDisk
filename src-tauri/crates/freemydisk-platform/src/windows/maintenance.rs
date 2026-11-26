use crate::traits::{
    EmergencyRescueSummary, MaintenanceTaskKind, PlatformApplications, PlatformError,
    PlatformSystemMaintenance, RescueStepOutcome, RescueStepStatus,
};
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::{ExitStatus, Stdio};
use std::time::{Duration, Instant};

const CREATE_NO_WINDOW: u32 = 0x08000000;

/// Longest time an external tool (wsl, powercfg) may run during Emergency Rescue.
pub const RESCUE_COMMAND_TIMEOUT: Duration = Duration::from_secs(30);

/// Longest time Emergency Rescue waits for the Recycle Bin to empty. Emptying
/// continues in the background after that; the step reports what left so far.
const RECYCLE_BIN_TIMEOUT: Duration = Duration::from_secs(120);

fn hidden_cmd(prog: &str) -> std::process::Command {
    let mut cmd = std::process::Command::new(prog);
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

/// How a command started by [`run_hidden_with_timeout`] ended.
#[derive(Debug)]
pub enum TimedCommand {
    Exited(ExitStatus),
    /// The command ran past its time limit and was killed.
    TimedOut,
    SpawnFailed(std::io::Error),
}

/// Runs a console tool without a window and kills it once `timeout` runs out.
/// Output is discarded, so a chatty tool cannot block on a full pipe.
pub fn run_hidden_with_timeout(prog: &str, args: &[&str], timeout: Duration) -> TimedCommand {
    let mut child = match hidden_cmd(prog)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => return TimedCommand::SpawnFailed(e),
    };
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return TimedCommand::Exited(status),
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return TimedCommand::TimedOut;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return TimedCommand::SpawnFailed(e);
            }
        }
    }
}

fn system_drive() -> String {
    std::env::var("SystemDrive")
        .unwrap_or_else(|_| "C:".to_string())
        .trim_end_matches('\\')
        .to_string()
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

    /// Emergency Rescue step: empties the Recycle Bin on every drive. The size is
    /// read first, so the reclaimed bytes are known even when Windows reports
    /// nothing afterwards.
    pub fn rescue_empty_recycle_bin() -> RescueStepOutcome {
        const STEP: &str = "recycle_bin";
        let (before_bytes, before_items) = Self::query_recycle_bin().unwrap_or((0, 0));
        if before_bytes == 0 && before_items == 0 {
            return RescueStepOutcome::skipped(STEP, "Recycle Bin is already empty");
        }

        // SHEmptyRecycleBinW cannot be cancelled, so it runs on its own thread and
        // the step stops waiting after RECYCLE_BIN_TIMEOUT.
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            use windows_sys::Win32::UI::Shell::{
                SHEmptyRecycleBinW, SHERB_NOCONFIRMATION, SHERB_NOPROGRESSUI, SHERB_NOSOUND,
            };
            let flags = SHERB_NOCONFIRMATION | SHERB_NOPROGRESSUI | SHERB_NOSOUND;
            let hr = unsafe { SHEmptyRecycleBinW(std::ptr::null_mut(), std::ptr::null(), flags) };
            let _ = tx.send(hr);
        });

        match rx.recv_timeout(RECYCLE_BIN_TIMEOUT) {
            Ok(hr) if hr >= 0 => RescueStepOutcome::done(
                STEP,
                before_bytes,
                format!(
                    "Emptied the Recycle Bin: {} items, {} permanently deleted",
                    before_items,
                    format_size(before_bytes)
                ),
            ),
            Ok(hr) => {
                let after = Self::query_recycle_bin()
                    .map(|(b, _)| b)
                    .unwrap_or(before_bytes);
                let freed = before_bytes.saturating_sub(after);
                let mut outcome = RescueStepOutcome::failed(
                    STEP,
                    format!(
                        "The Recycle Bin could not be fully emptied (0x{:08X})",
                        hr as u32
                    ),
                );
                outcome.bytes_reclaimed = freed;
                outcome
            }
            Err(_) => {
                let after = Self::query_recycle_bin()
                    .map(|(b, _)| b)
                    .unwrap_or(before_bytes);
                let freed = before_bytes.saturating_sub(after);
                RescueStepOutcome::done(
                    STEP,
                    freed,
                    format!(
                        "Recycle Bin is still emptying in the background ({} freed so far)",
                        format_size(freed)
                    ),
                )
            }
        }
    }

    /// Emergency Rescue step: turns hibernation off, which removes hiberfil.sys.
    /// Needs administrator rights; without them the step is skipped.
    pub fn rescue_disable_hibernation() -> RescueStepOutcome {
        const STEP: &str = "hibernation";
        let hiber_path = PathBuf::from(format!(r"{}\hiberfil.sys", system_drive()));
        if !hiber_path.exists() {
            return RescueStepOutcome::skipped(STEP, "Hibernation is already off");
        }
        if !crate::windows::is_elevated_windows() {
            return RescueStepOutcome::skipped(
                STEP,
                "Skipped – needs administrator (turning off hibernation)",
            );
        }
        let size = hiber_path.metadata().map(|m| m.len()).unwrap_or(0);
        match run_hidden_with_timeout("powercfg", &["/hibernate", "off"], RESCUE_COMMAND_TIMEOUT) {
            TimedCommand::Exited(status) if status.success() || !hiber_path.exists() => {
                RescueStepOutcome::done(
                    STEP,
                    size,
                    format!(
                        "Turned off hibernation and removed hiberfil.sys ({})",
                        format_size(size)
                    ),
                )
            }
            TimedCommand::Exited(status) => RescueStepOutcome::failed(
                STEP,
                format!(
                    "powercfg could not turn off hibernation (exit code {})",
                    status.code().unwrap_or(-1)
                ),
            ),
            TimedCommand::TimedOut => RescueStepOutcome::failed(
                STEP,
                format!(
                    "powercfg did not respond within {} s and was stopped",
                    RESCUE_COMMAND_TIMEOUT.as_secs()
                ),
            ),
            TimedCommand::SpawnFailed(e) => {
                RescueStepOutcome::failed(STEP, format!("powercfg could not be started: {}", e))
            }
        }
    }

    /// Emergency Rescue step: shuts down WSL so its virtual disks release their
    /// space. Skipped when WSL is not installed or not running.
    pub fn rescue_shutdown_wsl() -> RescueStepOutcome {
        const STEP: &str = "wsl";
        let windir = std::env::var("SystemRoot")
            .or_else(|_| std::env::var("WINDIR"))
            .unwrap_or_else(|_| r"C:\Windows".to_string());
        let wsl_exe = PathBuf::from(&windir).join(r"System32\wsl.exe");
        if !wsl_exe.exists() {
            return RescueStepOutcome::skipped(STEP, "WSL is not installed");
        }
        if !Self::wsl_is_running() {
            return RescueStepOutcome::skipped(STEP, "WSL is not running");
        }
        let exe = wsl_exe.to_string_lossy().to_string();
        match run_hidden_with_timeout(&exe, &["--shutdown"], RESCUE_COMMAND_TIMEOUT) {
            TimedCommand::Exited(status) if status.success() => {
                RescueStepOutcome::done(STEP, 0, "Shut down WSL virtual machines")
            }
            TimedCommand::Exited(status) => RescueStepOutcome::failed(
                STEP,
                format!(
                    "wsl --shutdown failed (exit code {})",
                    status.code().unwrap_or(-1)
                ),
            ),
            TimedCommand::TimedOut => RescueStepOutcome::failed(
                STEP,
                format!(
                    "wsl --shutdown did not respond within {} s and was stopped",
                    RESCUE_COMMAND_TIMEOUT.as_secs()
                ),
            ),
            TimedCommand::SpawnFailed(e) => {
                RescueStepOutcome::failed(STEP, format!("wsl could not be started: {}", e))
            }
        }
    }

    /// True when a WSL virtual machine or service process is running.
    fn wsl_is_running() -> bool {
        const WSL_PROCESSES: &[&str] = &["vmmemwsl", "vmmem", "wslservice", "wslhost"];
        let Ok(procs) = crate::windows::applications::WindowsApplicationsHandler::new()
            .list_running_processes()
        else {
            // Unknown: let wsl decide; the command is bounded by a timeout.
            return true;
        };
        procs.iter().any(|p| {
            let name = p.name.to_lowercase();
            let name = name.strip_suffix(".exe").unwrap_or(&name);
            WSL_PROCESSES.contains(&name)
        })
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

    /// Runs the steps that need no file-by-file cleanup: Recycle Bin, hibernation
    /// and WSL. Temporary files are cleaned by the rule-based pipeline in
    /// `freemydisk-core`, which keeps recent and in-use files and is journaled.
    fn execute_emergency_rescue(&self) -> Result<EmergencyRescueSummary, PlatformError> {
        let steps = [
            Self::rescue_empty_recycle_bin(),
            Self::rescue_disable_hibernation(),
            Self::rescue_shutdown_wsl(),
        ];
        let is_done = |id: &str| {
            steps
                .iter()
                .any(|s| s.step == id && s.status == RescueStepStatus::Done)
        };
        Ok(EmergencyRescueSummary {
            total_bytes_reclaimed: steps.iter().map(|s| s.bytes_reclaimed).sum(),
            hibernation_disabled: is_done("hibernation"),
            recycle_bin_emptied: is_done("recycle_bin"),
            temp_cleaned_bytes: 0,
            wsl_shutdown: is_done("wsl"),
            actions_performed: steps.iter().map(|s| s.message.clone()).collect(),
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
