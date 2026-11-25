use freemydisk_core::applications::{ApplicationLeftover, ApplicationService, InstalledAppInfo};
use freemydisk_core::cleanup::cleaners::{
    AiModelAnalyzer, AiModelInfo, CondaCacheInfo, CondaCleaner, RustToolchainCleaner,
    RustToolchainScanResult,
};
use freemydisk_core::cleanup::disposal::{DisposalEngine, DisposalItemResult, DisposalSummary};
use freemydisk_core::cleanup::plan::CleanupPlan;
use freemydisk_core::cleanup::rule_engine::{RuleEngine, RuleScanCandidate, RuleScanSummary};
use freemydisk_core::filesystem::journal::{CrashRecoveryJournal, JournalRecord};
use freemydisk_core::optimization::{OptimizationOverview, OptimizationService};
use freemydisk_core::privacy::{PrivacyScanResult, PrivacyService};
use freemydisk_core::shared::progress::{AppScanProgress, CancellationToken};
use freemydisk_core::startup::{StartupItem, StartupService};
use freemydisk_core::storage::analyzer::{StorageAnalyzer, StorageTreeNode};
use freemydisk_core::storage::duplicates::{
    DuplicateDetector, DuplicateGroup, DuplicateScanResult,
};
use freemydisk_core::storage::heavy_folders::{HeavyFoldersScanResult, HeavyFoldersScanner};
use freemydisk_core::storage::large_files::{LargeFilesScanResult, LargeFilesScanner};
use freemydisk_core::system_maintenance::{MaintenanceResult, MaintenanceService, MaintenanceTask};
use freemydisk_platform::{
    get_platform, PlatformApplications, PlatformFilesystem, PlatformRebootQueue, StorageVolumeInfo,
};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

mod services;
mod state;
use services::application_icon::{ApplicationIcon, ApplicationIconService};
use state::{JournalState, PANIC_JOURNAL};

/// Trims the physical memory working set for both FreeMyDisk and any child processes
/// (such as WebView2 renderer/GPU processes), purging inactive pages back to Windows.
#[cfg(target_os = "windows")]
pub fn trim_process_working_set() {
    use std::collections::HashSet;
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::ProcessStatus::K32EmptyWorkingSet;
    use windows_sys::Win32::System::Threading::{
        GetCurrentProcess, OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_SET_QUOTA,
    };

    unsafe {
        // 1. Trim host process working set
        let current_handle = GetCurrentProcess();
        K32EmptyWorkingSet(current_handle);

        // 2. Identify all descendant processes (WebView2 browser, renderers, GPU, etc.)
        let current_pid = std::process::id();
        let mut app_pids = HashSet::new();
        app_pids.insert(current_pid);

        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot != INVALID_HANDLE_VALUE {
            let mut entries = Vec::new();
            let mut entry: PROCESSENTRY32W = std::mem::zeroed();
            entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;

            if Process32FirstW(snapshot, &mut entry) != 0 {
                loop {
                    entries.push((entry.th32ProcessID, entry.th32ParentProcessID));
                    if Process32NextW(snapshot, &mut entry) == 0 {
                        break;
                    }
                }
            }
            CloseHandle(snapshot);

            // Expand descendant PIDs (up to 3 levels)
            for _ in 0..3 {
                let mut added = false;
                for (pid, parent_pid) in &entries {
                    if app_pids.contains(parent_pid) && !app_pids.contains(pid) {
                        app_pids.insert(*pid);
                        added = true;
                    }
                }
                if !added {
                    break;
                }
            }

            // Trim working set for all child processes
            for pid in app_pids {
                if pid != current_pid {
                    let child_h =
                        OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_SET_QUOTA, 0, pid);
                    if !child_h.is_null() && child_h != INVALID_HANDLE_VALUE {
                        K32EmptyWorkingSet(child_h);
                        CloseHandle(child_h);
                    }
                }
            }
        }
    }
}

#[cfg(not(target_os = "windows"))]
pub fn trim_process_working_set() {}

#[tauri::command]
fn trim_process_memory() {
    trim_process_working_set();
}

#[tauri::command]
fn get_power_state() -> freemydisk_platform::power::PowerState {
    freemydisk_platform::power::get_system_power_state()
}

#[tauri::command]
fn get_virtualization_overview() -> freemydisk_core::virtualization::VirtualizationOverview {
    freemydisk_core::virtualization::get_virtualization_overview()
}

#[tauri::command]
#[allow(non_snake_case)]
async fn compact_wsl_distribution(
    distro_name: Option<String>,
    distroName: Option<String>,
) -> Result<freemydisk_core::virtualization::CompactionResult, String> {
    let name = distro_name.or(distroName).unwrap_or_default();
    if name.trim().is_empty() {
        return Err("WSL distribution name cannot be empty".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let _bg_guard = freemydisk_platform::io_priority::BackgroundExecutionGuard::enter();
        freemydisk_core::virtualization::WslManager::compact_distribution(name.trim())
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn docker_prune(prune_type: String) -> Result<u64, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _bg_guard = freemydisk_platform::io_priority::BackgroundExecutionGuard::enter();
        freemydisk_core::virtualization::DockerManager::prune(&prune_type)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Default, Clone)]
pub struct ScanCancellationState(pub Arc<Mutex<Option<CancellationToken>>>);

/// Leftover paths and registry keys returned by leftover scans in this session.
/// Cleanup only accepts these, so the webview cannot ask for arbitrary deletions.
#[derive(Default, Clone)]
pub struct LeftoverScanRegistry(Arc<Mutex<HashSet<String>>>);

impl LeftoverScanRegistry {
    fn record<'a>(&self, items: impl Iterator<Item = &'a str>) {
        let mut set = self.0.lock().unwrap_or_else(|e| e.into_inner());
        set.extend(items.map(|i| i.trim().to_lowercase()));
    }

    fn record_groups(&self, groups: &[freemydisk_core::applications::LeftoverGroup]) {
        self.record(
            groups
                .iter()
                .flat_map(|g| g.items.iter().map(|i| i.path_or_key.as_str())),
        );
    }

    /// Splits requested items into those produced by a scan and the rest.
    fn partition(&self, requested: &[String]) -> (Vec<String>, Vec<String>) {
        let set = self.0.lock().unwrap_or_else(|e| e.into_inner());
        requested
            .iter()
            .cloned()
            .partition(|r| set.contains(&r.trim().to_lowercase()))
    }

    fn forget<'a>(&self, items: impl Iterator<Item = &'a String>) {
        let mut set = self.0.lock().unwrap_or_else(|e| e.into_inner());
        for item in items {
            set.remove(&item.trim().to_lowercase());
        }
    }
}

/// Paths whose move to the Recycle Bin failed during this session.
/// Permanent deletion is only accepted for these paths, so the webview cannot
/// request permanent deletion of an arbitrary location.
#[derive(Default, Clone)]
pub struct FailedTrashRegistry(Arc<Mutex<HashSet<PathBuf>>>);

impl FailedTrashRegistry {
    fn key(path: &Path) -> PathBuf {
        PathBuf::from(
            freemydisk_core::shared::paths::normalize_path(path)
                .to_string_lossy()
                .to_lowercase(),
        )
    }

    fn record_item(&self, result: &DisposalItemResult) {
        let mut set = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let key = Self::key(&result.path);
        if result.success {
            set.remove(&key);
        } else if result.route_used == "trash" {
            set.insert(key);
        }
    }

    fn record_summary(&self, summary: &DisposalSummary) {
        for result in &summary.results {
            self.record_item(result);
        }
    }

    fn contains(&self, path: &Path) -> bool {
        let set = self.0.lock().unwrap_or_else(|e| e.into_inner());
        set.contains(&Self::key(path))
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct RecoveryStatus {
    pub has_interrupted: bool,
    pub interrupted_count: usize,
}

fn get_journal(app: &AppHandle) -> Result<CrashRecoveryJournal, String> {
    app.state::<JournalState>().0.clone()
}

fn get_lock_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let app_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let lock_dir = app_dir.join("locks");
    let _ = std::fs::create_dir_all(&lock_dir);
    Ok(lock_dir)
}

#[tauri::command]
fn get_recovery_status(app: AppHandle) -> Result<RecoveryStatus, String> {
    let journal = get_journal(&app)?;
    let in_flight = journal.list_in_flight().map_err(|e| e.to_string())?;

    Ok(RecoveryStatus {
        has_interrupted: !in_flight.is_empty(),
        interrupted_count: in_flight.len(),
    })
}

#[tauri::command]
fn acknowledge_recovery_banner(app: AppHandle) -> Result<(), String> {
    let journal = get_journal(&app)?;
    journal.acknowledge_in_flight().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn get_cleanup_history(
    app: AppHandle,
    limit: Option<usize>,
) -> Result<Vec<JournalRecord>, String> {
    let journal = get_journal(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        journal
            .list_recent_history(limit.unwrap_or(100))
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn clear_cleanup_history(app: AppHandle) -> Result<usize, String> {
    let journal = get_journal(&app)?;
    tauri::async_runtime::spawn_blocking(move || journal.clear_history().map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn log_frontend_exception(error: String, stack: Option<String>) -> Result<(), String> {
    log::error!("Frontend Exception: {} | Stack: {:?}", error, stack);
    if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
        let log_dir = std::path::PathBuf::from(local_app_data)
            .join("FreeMyDisk")
            .join("logs");
        let _ = std::fs::create_dir_all(&log_dir);
        let log_file = log_dir.join("frontend_errors.log");
        use std::io::Write;
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(log_file)
        {
            let timestamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let _ = writeln!(f, "[{}] Error: {} | Stack: {:?}", timestamp, error, stack);
        }
    }
    Ok(())
}

#[tauri::command]
fn check_disk_space_guard(target_path: String, required_bytes: u64) -> Result<(), String> {
    CrashRecoveryJournal::check_disk_space_guard(std::path::Path::new(&target_path), required_bytes)
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn remediate_interrupted_session(
    app: AppHandle,
) -> Result<Vec<freemydisk_core::filesystem::journal::RemediationResult>, String> {
    let journal = get_journal(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        journal
            .remediate_staged_crashes()
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn force_terminate_uninstaller(pid: u32) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        freemydisk_core::applications::process_control::ProcessController::terminate_by_pid(pid)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn track_uninstaller_watchdog(app: AppHandle, pid: u32, app_name: String) {
    std::thread::spawn(move || {
        let start = std::time::Instant::now();
        loop {
            std::thread::sleep(std::time::Duration::from_secs(1));
            if !freemydisk_core::applications::process_control::ProcessController::is_process_alive(
                pid,
            ) {
                break;
            }
            if start.elapsed().as_secs() >= 45 {
                log::warn!(
                    "Watchdog: Uninstaller for '{}' (PID {}) unresponsive for >45s",
                    app_name,
                    pid
                );
                use tauri::Emitter;
                let _ = app.emit(
                    "uninstaller-hung",
                    serde_json::json!({
                        "pid": pid,
                        "app_name": app_name,
                        "elapsed_seconds": start.elapsed().as_secs(),
                    }),
                );
                break;
            }
        }
    });
}

#[tauri::command]
async fn generate_diagnostic_bundle(app: AppHandle) -> Result<String, String> {
    let app_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let os_info = std::env::consts::OS;
        let arch_info = std::env::consts::ARCH;
        let journal_path = app_dir.join("journal.db");
        let journal_exists = journal_path.exists();

        let journal_integrity = if journal_exists {
            if let Ok(journal) = CrashRecoveryJournal::open(&journal_path) {
                journal
                    .check_integrity()
                    .unwrap_or_else(|e| format!("Error checking integrity: {}", e))
            } else {
                "Failed to open journal".to_string()
            }
        } else {
            "Not created yet".to_string()
        };

        let vitals_str = if let Ok(vitals) = get_platform().get_system_vitals() {
            format!(
                "RAM: {:.1} GB / {:.1} GB ({}%), Cores: {}, OS: {}",
                vitals.used_ram_bytes as f64 / 1_073_741_824.0,
                vitals.total_ram_bytes as f64 / 1_073_741_824.0,
                vitals.memory_load_percent,
                vitals.cpu_cores,
                vitals.os_name,
            )
        } else {
            "N/A".to_string()
        };

        // Recent frontend error log entries
        let mut recent_logs = String::new();
        if let Ok(local_app) = std::env::var("LOCALAPPDATA") {
            let log_file = std::path::PathBuf::from(local_app)
                .join("FreeMyDisk")
                .join("logs")
                .join("frontend_errors.log");
            if log_file.exists() {
                if let Ok(content) = std::fs::read_to_string(&log_file) {
                    let lines: Vec<&str> = content.lines().rev().take(20).collect();
                    recent_logs = lines.into_iter().rev().collect::<Vec<&str>>().join("\n");
                }
            }
        }

        // Recent crash dumps count
        let crash_count =
            freemydisk_core::filesystem::crash_report::CrashDumpReport::list_reports()
                .map(|l| l.len())
                .unwrap_or(0);

        let report = format!(
            "=== FreeMyDisk Privacy-Sanitized Diagnostic Bundle ===\n\
             Version: {}\n\
             Platform: {} ({})\n\
             System Vitals: {}\n\
             Journal Status: Present ({}) | Integrity Check: {}\n\
             Crash Dumps on Disk: {}\n\
             Generated: {:?}\n\n\
             --- Recent Frontend Log Snippet ---\n\
             {}\n\
             =======================================================",
            env!("CARGO_PKG_VERSION"),
            os_info,
            arch_info,
            vitals_str,
            journal_exists,
            journal_integrity,
            crash_count,
            std::time::SystemTime::now(),
            if recent_logs.is_empty() {
                "No frontend errors recorded"
            } else {
                &recent_logs
            }
        );

        let sanitized =
            freemydisk_core::filesystem::crash_report::sanitize_diagnostic_text(&report);

        // Also write diagnostic text report to user desktop or app data for 1-click sharing
        if let Ok(profile) = std::env::var("USERPROFILE") {
            let desktop = std::path::PathBuf::from(profile).join("Desktop");
            if desktop.exists() {
                let now_ts = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                let bundle_file = desktop.join(format!("FreeMyDisk_Diagnostic_{}.txt", now_ts));
                let _ = std::fs::write(bundle_file, &sanitized);
            }
        }

        Ok(sanitized)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn list_pending_reboot_deletions(
) -> Result<Vec<freemydisk_platform::traits::PendingRebootDeletion>, String> {
    let platform = get_platform();
    platform.list_pending_deletions().map_err(|e| e.to_string())
}

#[tauri::command]
fn cancel_pending_reboot_deletion(path: String) -> Result<(), String> {
    let platform = get_platform();
    platform
        .cancel_pending_deletion(&PathBuf::from(path))
        .map_err(|e| e.to_string())
}

fn detect_locking_process(
    rule_id: &str,
    running_procs: &std::collections::HashSet<String>,
) -> Option<String> {
    let check = |names: &[&str]| {
        for &name in names {
            if running_procs.contains(&name.to_lowercase()) {
                return Some(name.to_string());
            }
        }
        None
    };

    let rid = rule_id.to_lowercase();
    if rid.contains("chrome") {
        check(&["chrome.exe"])
    } else if rid.contains("edge") {
        check(&["msedge.exe"])
    } else if rid.contains("firefox") {
        check(&["firefox.exe"])
    } else if rid.contains("brave") {
        check(&["brave.exe"])
    } else if rid.contains("opera") {
        check(&["opera.exe"])
    } else if rid.contains("spotify") {
        check(&["spotify.exe"])
    } else if rid.contains("discord") {
        check(&["discord.exe"])
    } else if rid.contains("slack") {
        check(&["slack.exe"])
    } else if rid.contains("vscode") {
        check(&["code.exe"])
    } else if rid.contains("cursor") {
        check(&["cursor.exe"])
    } else if rid.contains("postman") {
        check(&["postman.exe"])
    } else if rid.contains("telegram") {
        check(&["telegram.exe"])
    } else if rid.contains("whatsapp") {
        check(&["whatsapp.exe"])
    } else if rid.contains("notion") {
        check(&["notion.exe"])
    } else if rid.contains("docker") {
        check(&["docker.exe", "docker desktop.exe"])
    } else if rid.contains("jetbrains") {
        check(&[
            "idea64.exe",
            "pycharm64.exe",
            "webstorm64.exe",
            "clion64.exe",
            "rider64.exe",
            "goland64.exe",
            "rustrover64.exe",
        ])
    } else if rid.contains("visual_studio") {
        check(&["devenv.exe"])
    } else if rid.contains("steam") {
        check(&["steam.exe"])
    } else if rid.contains("adobe") {
        check(&[
            "photoshop.exe",
            "illustrator.exe",
            "premiere.exe",
            "creative cloud.exe",
        ])
    } else if rid.contains("ollama") {
        check(&["ollama.exe", "ollama_app.exe"])
    } else if rid.contains("vivaldi") {
        check(&["vivaldi.exe"])
    } else if rid.contains("arc") {
        check(&["arc.exe"])
    } else if rid.contains("chromium") {
        check(&["chromium.exe"])
    } else if rid.contains("duckduckgo") {
        check(&["duckduckgo.exe"])
    } else if rid.contains("waterfox") {
        check(&["waterfox.exe"])
    } else if rid.contains("floorp") {
        check(&["floorp.exe"])
    } else if rid.contains("librewolf") {
        check(&["librewolf.exe"])
    } else if rid.contains("tor") {
        check(&["tor.exe", "firefox.exe"])
    } else if rid.contains("yandex") {
        check(&["browser.exe", "yandex.exe"])
    } else if rid.contains("samsung_internet") {
        check(&["samsunginternet.exe"])
    } else if rid.contains("teams") {
        check(&["teams.exe", "ms-teams.exe"])
    } else if rid.contains("zoom") {
        check(&["zoom.exe"])
    } else if rid.contains("obs") {
        check(&["obs64.exe", "obs32.exe"])
    } else if rid.contains("signal") {
        check(&["signal.exe"])
    } else if rid.contains("vlc") {
        check(&["vlc.exe"])
    } else if rid.contains("wps") {
        check(&["wps.exe", "wpp.exe", "et.exe"])
    } else if rid.contains("battle_net") {
        check(&["battle.net.exe", "agent.exe"])
    } else if rid.contains("ea_app") {
        check(&["eadesktop.exe"])
    } else if rid.contains("epic_games") {
        check(&["epicgameslauncher.exe"])
    } else if rid.contains("gog") {
        check(&["galaxyclient.exe"])
    } else if rid.contains("figma") {
        check(&["figma.exe"])
    } else if rid.contains("obsidian") {
        check(&["obsidian.exe"])
    } else if rid.contains("linear") {
        check(&["linear.exe"])
    } else if rid.contains("todoist") {
        check(&["todoist.exe"])
    } else if rid.contains("thunderbird") {
        check(&["thunderbird.exe"])
    } else if rid.contains("outlook") {
        check(&["olk.exe", "outlook.exe"])
    } else if rid.contains("dropbox") {
        check(&["dropbox.exe"])
    } else if rid.contains("onedrive") {
        check(&["onedrive.exe"])
    } else if rid.contains("google_drive") {
        check(&["googledrivefs.exe"])
    } else if rid.contains("twitch") {
        check(&["twitch.exe"])
    } else if rid.contains("skype") {
        check(&["skype.exe"])
    } else if rid.contains("wechat") {
        check(&["wechat.exe"])
    } else if rid.contains("sublime") {
        check(&["sublime_text.exe"])
    } else if rid.contains("lmstudio") {
        check(&["lm studio.exe"])
    } else if rid.contains("podman") {
        check(&["podman-desktop.exe"])
    } else if rid.contains("rancher") {
        check(&["rancher desktop.exe"])
    } else {
        None
    }
}

#[tauri::command]
async fn scan_cleanup_rules(app: AppHandle) -> Result<Vec<RuleScanSummary>, String> {
    let app_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let app_emitter = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _bg_guard = freemydisk_platform::io_priority::BackgroundExecutionGuard::enter();
        let mut engine = RuleEngine::new();
        let custom_rules_dir = app_dir.join("custom_rules");
        let _ = engine.load_custom_rules_from_dir(&custom_rules_dir);
        let cancel = CancellationToken::new();

        let app_emit_cb = app_emitter.clone();
        let mut summaries = engine
            .scan_all_with_progress(&cancel, |rule_name, completed, total, bytes_found| {
                let pct = ((completed * 100) / total.max(1)).clamp(1, 100) as u8;
                let _ = app_emit_cb.emit(
                    "scan-progress",
                    AppScanProgress {
                        scan_type: "cleanup".to_string(),
                        stage: format!("Scanning Rule {}/{}: {}", completed, total, rule_name),
                        percent: pct,
                        items_scanned: completed as u64,
                        current_path: rule_name.to_string(),
                        bytes_found,
                        is_complete: completed >= total,
                    },
                );
            })
            .map_err(|e| e.to_string())?;

        // 1. Incorporate Windows Recycle Bin directly as a first-class system cleanup rule
        #[cfg(target_os = "windows")]
        {
            use freemydisk_platform::windows::maintenance::WindowsSystemMaintenanceHandler;
            if let Ok((bin_bytes, bin_count)) = WindowsSystemMaintenanceHandler::query_recycle_bin()
            {
                if bin_bytes > 0 || bin_count > 0 {
                    summaries.insert(
                        0,
                        RuleScanSummary {
                            rule_id: "windows_recycle_bin".to_string(),
                            rule_name: "Windows Recycle Bin".to_string(),
                            category: "system".to_string(),
                            risk: "safe".to_string(),
                            verified_rebuildable: true,
                            default_action: "permanent".to_string(),
                            default_selected: true,
                            total_bytes: bin_bytes,
                            total_items: bin_count as usize,
                            candidates: Vec::new(),
                            is_locked_by_process: false,
                            locking_process_name: None,
                        },
                    );
                }
            }
        }

        // 2. Correlate with active running processes
        let platform = get_platform();
        if let Ok(procs) = platform.list_running_processes() {
            let proc_set: std::collections::HashSet<String> =
                procs.into_iter().map(|p| p.name.to_lowercase()).collect();
            for s in &mut summaries {
                if let Some(lock_name) = detect_locking_process(&s.rule_id, &proc_set) {
                    s.is_locked_by_process = true;
                    s.locking_process_name = Some(lock_name);
                }
            }
        }

        let total_bytes: u64 = summaries.iter().map(|s| s.total_bytes).sum();
        let _ = app_emitter.emit(
            "scan-progress",
            AppScanProgress {
                scan_type: "cleanup".to_string(),
                stage: "Cleanup scan completed".to_string(),
                percent: 100,
                items_scanned: summaries.len() as u64,
                current_path: String::new(),
                bytes_found: total_bytes,
                is_complete: true,
            },
        );

        trim_process_working_set();
        Ok(summaries)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
#[allow(non_snake_case)]
async fn close_locking_process(
    process_name: Option<String>,
    processName: Option<String>,
) -> Result<bool, String> {
    let name = process_name
        .or(processName)
        .ok_or_else(|| "Missing process name".to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let platform = get_platform();
        if let Ok(procs) = platform.list_running_processes() {
            let target = name.to_lowercase();
            let mut closed_any = false;
            for p in procs {
                if p.name.to_lowercase() == target && platform.terminate_process(p.pid).is_ok() {
                    closed_any = true;
                }
            }
            Ok(closed_any)
        } else {
            Err("Failed to query running processes".to_string())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
#[allow(non_snake_case)]
async fn close_all_locking_processes(
    process_names: Option<Vec<String>>,
    processNames: Option<Vec<String>>,
) -> Result<usize, String> {
    let targets = process_names.or(processNames).unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || {
        let platform = get_platform();
        if let Ok(procs) = platform.list_running_processes() {
            let target_set: std::collections::HashSet<String> =
                targets.into_iter().map(|n| n.to_lowercase()).collect();
            let mut closed_count = 0;
            for p in procs {
                if target_set.contains(&p.name.to_lowercase())
                    && platform.terminate_process(p.pid).is_ok()
                {
                    closed_count += 1;
                }
            }
            Ok(closed_count)
        } else {
            Err("Failed to query running processes".to_string())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn execute_cleanup_plan(
    app: AppHandle,
    candidates: Vec<RuleScanCandidate>,
    always_trash: bool,
) -> Result<DisposalSummary, String> {
    let journal = get_journal(&app)?;
    let failed_trash = app.state::<FailedTrashRegistry>().inner().clone();
    let lock_dir = get_lock_dir(&app)?;
    let res = tauri::async_runtime::spawn_blocking(move || {
        let _bg_guard = freemydisk_platform::io_priority::BackgroundExecutionGuard::enter();
        let platform = get_platform();
        let cancel = CancellationToken::new();
        let plan = CleanupPlan::from_candidates(candidates);
        let res = DisposalEngine::execute_plan(
            &plan.items,
            &platform,
            &journal,
            &lock_dir,
            always_trash,
            &cancel,
        )
        .map_err(|e| e.to_string());

        if let Ok(ref s) = res {
            if s.total_freed_bytes >= 5 * 1024 * 1024 * 1024 {
                freemydisk_platform::storage_optim::trigger_background_trim_if_ssd('C');
            }
            let _ = platform.refresh_shell();
        }

        trim_process_working_set();
        res
    })
    .await
    .map_err(|e| e.to_string())?;
    if let Ok(ref r) = res {
        failed_trash.record_summary(r);
    }
    res
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CleanupPlanInput {
    #[serde(alias = "rule_ids")]
    rule_ids: Option<Vec<String>>,
    #[serde(default, alias = "dry_run")]
    dry_run: Option<bool>,
    #[serde(default, alias = "force_permanent")]
    force_permanent: Option<bool>,
    #[serde(default, alias = "always_trash")]
    always_trash: Option<bool>,
    #[serde(default, alias = "close_locking_apps")]
    close_locking_apps: Option<bool>,
}

#[tauri::command]
#[allow(non_snake_case)]
async fn execute_cleanup_rules(
    app: AppHandle,
    rule_ids: Option<Vec<String>>,
    ruleIds: Option<Vec<String>>,
    always_trash: Option<bool>,
    alwaysTrash: Option<bool>,
    plan: Option<CleanupPlanInput>,
) -> Result<DisposalSummary, String> {
    let journal = get_journal(&app)?;
    let failed_trash = app.state::<FailedTrashRegistry>().inner().clone();
    let effective_rule_ids = if let Some(ids) = rule_ids.or(ruleIds) {
        ids
    } else if let Some(p) = &plan {
        p.rule_ids.clone().unwrap_or_default()
    } else {
        Vec::new()
    };

    let effective_always_trash = if let Some(at) = always_trash.or(alwaysTrash) {
        at
    } else if let Some(p) = &plan {
        if let Some(at) = p.always_trash {
            at
        } else if let Some(fp) = p.force_permanent {
            !fp
        } else {
            true
        }
    } else {
        true
    };

    let is_dry_run = plan.as_ref().and_then(|p| p.dry_run).unwrap_or(false);
    let should_close_apps = !is_dry_run
        && plan
            .as_ref()
            .and_then(|p| p.close_locking_apps)
            .unwrap_or(true);

    let app_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let lock_dir = get_lock_dir(&app)?;
    let res = tauri::async_runtime::spawn_blocking(move || {
        let _bg_guard = freemydisk_platform::io_priority::BackgroundExecutionGuard::enter();
        let platform = get_platform();
        let cancel = CancellationToken::new();

        // If dry_run simulation, do not modify files, do not close apps, do not empty recycle bin
        if is_dry_run {
            let custom_rules_dir = app_dir.join("custom_rules");
            let mut engine = RuleEngine::new();
            let _ = engine.load_custom_rules_from_dir(&custom_rules_dir);
            let candidates = engine
                .scan_all_candidates(&effective_rule_ids, &cancel)
                .map_err(|e| e.to_string())?;

            let mut total_bytes = 0u64;
            let mut results = Vec::new();

            #[cfg(target_os = "windows")]
            if effective_rule_ids
                .iter()
                .any(|id| id == "windows_recycle_bin")
            {
                use freemydisk_platform::windows::maintenance::WindowsSystemMaintenanceHandler;
                if let Ok((bin_bytes, _)) = WindowsSystemMaintenanceHandler::query_recycle_bin() {
                    total_bytes += bin_bytes;
                    results.push(DisposalItemResult {
                        path: PathBuf::from(r"C:\$Recycle.Bin"),
                        success: true,
                        bytes_freed: bin_bytes,
                        route_used: "dry_run".to_string(),
                        error: None,
                    });
                }
            }

            for c in &candidates {
                total_bytes += c.size_bytes;
                results.push(DisposalItemResult {
                    path: c.path.clone(),
                    success: true,
                    bytes_freed: c.size_bytes,
                    route_used: "dry_run".to_string(),
                    error: None,
                });
            }

            let total_items = results.len();
            trim_process_working_set();
            return Ok(DisposalSummary {
                session_id: "dry-run-simulation".to_string(),
                total_freed_bytes: total_bytes,
                successful_items: total_items,
                failed_items: 0,
                total_requested_items: total_items,
                results,
                failed_trash_paths: Vec::new(),
            });
        }

        // 1. Optionally close locking applications before deleting their caches
        if should_close_apps {
            let mut closed_any = false;
            if let Ok(procs) = platform.list_running_processes() {
                let proc_set: std::collections::HashSet<String> =
                    procs.into_iter().map(|p| p.name.to_lowercase()).collect();
                for r_id in &effective_rule_ids {
                    if let Some(p_name) = detect_locking_process(r_id, &proc_set) {
                        if let Ok(live_procs) = platform.list_running_processes() {
                            for p in live_procs {
                                if p.name.eq_ignore_ascii_case(&p_name)
                                    && platform.terminate_process(p.pid).is_ok()
                                {
                                    closed_any = true;
                                }
                            }
                        }
                    }
                }
            }
            if closed_any {
                // Brief pause so Windows OS flushes and releases all locks on memory-mapped cache databases
                std::thread::sleep(std::time::Duration::from_millis(300));
            }
        }

        // 2. Special handler for Windows Recycle Bin if requested
        let mut recycle_bin_freed = 0u64;
        let mut recycle_bin_success = false;
        #[cfg(target_os = "windows")]
        if effective_rule_ids
            .iter()
            .any(|id| id == "windows_recycle_bin")
        {
            use freemydisk_platform::windows::maintenance::WindowsSystemMaintenanceHandler;
            let initial = WindowsSystemMaintenanceHandler::query_recycle_bin()
                .map(|(b, _)| b)
                .unwrap_or(0);
            unsafe {
                use windows_sys::Win32::UI::Shell::{
                    SHEmptyRecycleBinW, SHERB_NOCONFIRMATION, SHERB_NOPROGRESSUI, SHERB_NOSOUND,
                };
                let flags = SHERB_NOCONFIRMATION | SHERB_NOPROGRESSUI | SHERB_NOSOUND;
                let _ = SHEmptyRecycleBinW(std::ptr::null_mut(), std::ptr::null(), flags);
            }
            let after = WindowsSystemMaintenanceHandler::query_recycle_bin()
                .map(|(b, _)| b)
                .unwrap_or(0);
            let freed = initial.saturating_sub(after);
            recycle_bin_freed = if freed > 0 { freed } else { initial };
            recycle_bin_success = true;
        }

        // 3. Scan and execute filesystem rule candidates
        let custom_rules_dir = app_dir.join("custom_rules");
        let mut engine = RuleEngine::new();
        let _ = engine.load_custom_rules_from_dir(&custom_rules_dir);
        let candidates = engine
            .scan_all_candidates(&effective_rule_ids, &cancel)
            .map_err(|e| e.to_string())?;
        let plan = CleanupPlan::from_candidates(candidates);
        let app_emit_cb = app.clone();
        let mut summary = DisposalEngine::execute_plan_with_progress(
            &plan.items,
            &platform,
            &journal,
            &lock_dir,
            effective_always_trash,
            &cancel,
            |idx, total, path, bytes_freed| {
                let pct = ((idx * 100) / total.max(1)).clamp(1, 100) as u8;
                let _ = app_emit_cb.emit(
                    "scan-progress",
                    AppScanProgress {
                        scan_type: "disposal".to_string(),
                        stage: format!("Disposing item {} of {}", idx, total),
                        percent: pct,
                        items_scanned: idx as u64,
                        current_path: path.to_string_lossy().to_string(),
                        bytes_found: bytes_freed,
                        is_complete: idx >= total,
                    },
                );
            },
        )
        .map_err(|e| e.to_string())?;

        // 4. Merge Recycle Bin results if emptied
        if recycle_bin_success {
            summary.total_freed_bytes += recycle_bin_freed;
            summary.successful_items += 1;
            summary.total_requested_items += 1;
            summary.results.insert(
                0,
                DisposalItemResult {
                    path: PathBuf::from(r"C:\$Recycle.Bin"),
                    success: true,
                    bytes_freed: recycle_bin_freed,
                    route_used: "permanent".to_string(),
                    error: None,
                },
            );
        }

        if summary.total_freed_bytes >= 5 * 1024 * 1024 * 1024 {
            freemydisk_platform::storage_optim::trigger_background_trim_if_ssd('C');
        }
        let _ = platform.refresh_shell();

        let _ = app.emit(
            "scan-progress",
            AppScanProgress {
                scan_type: "disposal".to_string(),
                stage: "Disposal completed".to_string(),
                percent: 100,
                items_scanned: summary.successful_items as u64,
                current_path: String::new(),
                bytes_found: summary.total_freed_bytes,
                is_complete: true,
            },
        );

        trim_process_working_set();
        Ok(summary)
    })
    .await
    .map_err(|e| e.to_string())?;
    if let Ok(ref r) = res {
        failed_trash.record_summary(r);
    }
    res
}

#[tauri::command]
async fn retry_failed_trash(app: AppHandle, path: String) -> Result<DisposalItemResult, String> {
    let journal = get_journal(&app)?;
    let failed_trash = app.state::<FailedTrashRegistry>().inner().clone();
    let lock_dir = get_lock_dir(&app)?;
    let res = tauri::async_runtime::spawn_blocking(move || {
        let platform = get_platform();
        let cancel = CancellationToken::new();

        let pb = PathBuf::from(&path);
        let size = pb.metadata().map(|m| m.len()).unwrap_or(0);
        let canon = freemydisk_core::shared::paths::normalize_path(&pb);

        let item = freemydisk_core::cleanup::plan::CleanupPlanItem {
            original_path: pb,
            canonical_path: canon,
            size_bytes: size,
            is_dir: false,
            matched_rules: vec!["retry_trash".to_string()],
            default_action: "trash".to_string(),
            verified_rebuildable: false,
            protect_subpaths: Vec::new(),
            risk: "safe".to_string(),
        };

        let summary =
            DisposalEngine::execute_plan(&[item], &platform, &journal, &lock_dir, true, &cancel)
                .map_err(|e| e.to_string())?;

        summary
            .results
            .into_iter()
            .next()
            .ok_or_else(|| "Failed to execute retry".to_string())
    })
    .await
    .map_err(|e| e.to_string())?;
    if let Ok(ref r) = res {
        failed_trash.record_item(r);
    }
    res
}

#[tauri::command]
async fn force_delete_permanently(
    app: AppHandle,
    path: String,
) -> Result<DisposalItemResult, String> {
    let journal = get_journal(&app)?;
    let failed_trash = app.state::<FailedTrashRegistry>().inner().clone();
    let pb = PathBuf::from(path);
    if !failed_trash.contains(&pb) {
        return Err(
            "Permanent delete is only available for items that could not be moved to the Recycle Bin."
                .to_string(),
        );
    }

    let lock_dir = get_lock_dir(&app)?;
    let res = tauri::async_runtime::spawn_blocking(move || {
        let platform = get_platform();

        DisposalEngine::execute_manual_permanent_delete(&pb, &journal, &platform, &lock_dir)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?;
    if let Ok(ref r) = res {
        failed_trash.record_item(r);
    }
    res
}

#[tauri::command]
fn get_storage_volumes() -> Result<Vec<StorageVolumeInfo>, String> {
    let platform = get_platform();
    Ok(StorageAnalyzer::list_volumes(&platform))
}

#[tauri::command]
fn cancel_active_scan(cancel_state: State<'_, ScanCancellationState>) -> bool {
    let mut guard = cancel_state.0.lock().unwrap();
    if let Some(token) = guard.take() {
        token.cancel();
        true
    } else {
        false
    }
}

#[tauri::command]
async fn get_application_icons(paths: Vec<String>) -> Result<Vec<ApplicationIcon>, String> {
    tauri::async_runtime::spawn_blocking(move || ApplicationIconService::load_icons(paths))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[allow(non_snake_case)]
async fn scan_storage_tree(
    app: AppHandle,
    cancel_state: State<'_, ScanCancellationState>,
    path: String,
    max_depth: Option<usize>,
    maxDepth: Option<usize>,
) -> Result<StorageTreeNode, String> {
    let effective_depth = max_depth.or(maxDepth).unwrap_or(3);
    let cancel = CancellationToken::new();
    {
        let mut guard = cancel_state.0.lock().unwrap();
        *guard = Some(cancel.clone());
    }
    let cancel_for_task = cancel.clone();

    let _ = app.emit(
        "scan-progress",
        AppScanProgress {
            scan_type: "storage".to_string(),
            stage: format!("Scanning storage hierarchy: {}", path),
            percent: 25,
            items_scanned: 1,
            current_path: path.clone(),
            bytes_found: 0,
            is_complete: false,
        },
    );

    let path_clone = path.clone();
    let res = tauri::async_runtime::spawn_blocking(move || {
        let platform = get_platform();
        let pb = PathBuf::from(path_clone);
        StorageAnalyzer::scan_directory(&pb, effective_depth, &platform, &cancel_for_task)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?;

    {
        let mut guard = cancel_state.0.lock().unwrap();
        *guard = None;
    }

    if let Ok(ref tree) = res {
        let _ = app.emit(
            "scan-progress",
            AppScanProgress {
                scan_type: "storage".to_string(),
                stage: "Storage hierarchy scan completed".to_string(),
                percent: 100,
                items_scanned: tree.file_count + tree.dir_count,
                current_path: path,
                bytes_found: tree.size_bytes,
                is_complete: true,
            },
        );
    }

    trim_process_working_set();
    res
}

#[tauri::command]
#[allow(non_snake_case)]
async fn scan_directory_storage(
    app: AppHandle,
    cancel_state: State<'_, ScanCancellationState>,
    path: String,
    max_depth: Option<usize>,
    maxDepth: Option<usize>,
) -> Result<StorageTreeNode, String> {
    scan_storage_tree(app, cancel_state, path, max_depth, maxDepth).await
}

#[tauri::command]
fn export_storage_scan(tree: StorageTreeNode, format: String) -> Result<String, String> {
    if format.eq_ignore_ascii_case("csv") {
        StorageAnalyzer::export_to_csv(&tree).map_err(|e| e.to_string())
    } else {
        StorageAnalyzer::export_to_json(&tree).map_err(|e| e.to_string())
    }
}

#[tauri::command]
#[allow(non_snake_case)]
async fn scan_heavy_folders(
    app: AppHandle,
    cancel_state: State<'_, ScanCancellationState>,
    root: String,
    min_size_bytes: Option<u64>,
    minSizeBytes: Option<u64>,
) -> Result<HeavyFoldersScanResult, String> {
    let effective_min = min_size_bytes
        .or(minSizeBytes)
        .unwrap_or(1024 * 1024 * 1024);
    let cancel = CancellationToken::new();
    {
        let mut guard = cancel_state.0.lock().unwrap();
        *guard = Some(cancel.clone());
    }
    let cancel_for_task = cancel.clone();
    let app_emitter = app.clone();
    let res = tauri::async_runtime::spawn_blocking(move || {
        let pb = PathBuf::from(root);
        let app_emit_cb = app_emitter.clone();
        HeavyFoldersScanner::scan_heavy_folders_with_progress(
            &pb,
            effective_min,
            6,
            &cancel_for_task,
            |current_path, items_scanned, bytes_found| {
                let pct = ((items_scanned % 99) + 1).min(99) as u8;
                let _ = app_emit_cb.emit(
                    "scan-progress",
                    AppScanProgress {
                        scan_type: "heavy_folders".to_string(),
                        stage: format!("Analyzing directory weights ({} scanned)", items_scanned),
                        percent: pct,
                        items_scanned,
                        current_path: current_path.to_string_lossy().to_string(),
                        bytes_found,
                        is_complete: false,
                    },
                );
            },
        )
        .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?;

    {
        let mut guard = cancel_state.0.lock().unwrap();
        *guard = None;
    }

    if let Ok(ref result) = res {
        let _ = app.emit(
            "scan-progress",
            AppScanProgress {
                scan_type: "heavy_folders".to_string(),
                stage: "Heavy folder analysis completed".to_string(),
                percent: 100,
                items_scanned: result.total_scanned_files,
                current_path: String::new(),
                bytes_found: result.total_scanned_bytes,
                is_complete: true,
            },
        );
    }

    trim_process_working_set();
    res
}

#[tauri::command]
#[allow(non_snake_case, clippy::too_many_arguments)]
async fn scan_large_files(
    app: AppHandle,
    cancel_state: State<'_, ScanCancellationState>,
    roots: Option<Vec<String>>,
    root: Option<String>,
    root_path: Option<String>,
    rootPath: Option<String>,
    min_size_bytes: Option<u64>,
    minSizeBytes: Option<u64>,
) -> Result<LargeFilesScanResult, String> {
    let mut targets = roots.unwrap_or_default();
    if targets.is_empty() {
        if let Some(r) = root.or(root_path).or(rootPath) {
            targets.push(r);
        }
    }
    if targets.is_empty() {
        targets.push("C:\\".to_string());
    }

    let effective_min = min_size_bytes.or(minSizeBytes).unwrap_or(100 * 1024 * 1024);
    let cancel = CancellationToken::new();
    {
        let mut guard = cancel_state.0.lock().unwrap();
        *guard = Some(cancel.clone());
    }
    let cancel_for_task = cancel.clone();
    let app_emitter = app.clone();
    let res = tauri::async_runtime::spawn_blocking(move || {
        let pbs: Vec<PathBuf> = targets.into_iter().map(PathBuf::from).collect();
        let app_emit_cb = app_emitter.clone();
        LargeFilesScanner::scan_large_files_with_progress(
            &pbs,
            effective_min,
            &cancel_for_task,
            |current_path, items_scanned, bytes_found| {
                let pct = ((items_scanned % 99) + 1).min(99) as u8;
                let _ = app_emit_cb.emit(
                    "scan-progress",
                    AppScanProgress {
                        scan_type: "large_files".to_string(),
                        stage: format!("Scanning large files ({} scanned)", items_scanned),
                        percent: pct,
                        items_scanned,
                        current_path: current_path.to_string_lossy().to_string(),
                        bytes_found,
                        is_complete: false,
                    },
                );
            },
        )
        .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?;

    {
        let mut guard = cancel_state.0.lock().unwrap();
        *guard = None;
    }

    if let Ok(ref result) = res {
        let _ = app.emit(
            "scan-progress",
            AppScanProgress {
                scan_type: "large_files".to_string(),
                stage: "Large files scan completed".to_string(),
                percent: 100,
                items_scanned: result.total_files as u64,
                current_path: String::new(),
                bytes_found: result.total_bytes,
                is_complete: true,
            },
        );
    }

    trim_process_working_set();
    res
}

#[tauri::command]
async fn trash_large_file(app: AppHandle, path: String) -> Result<DisposalItemResult, String> {
    let journal = get_journal(&app)?;
    let failed_trash = app.state::<FailedTrashRegistry>().inner().clone();
    let lock_dir = get_lock_dir(&app)?;
    let res = tauri::async_runtime::spawn_blocking(move || {
        let platform = get_platform();
        let pb = PathBuf::from(path);
        LargeFilesScanner::trash_large_file(&pb, &platform, &journal, &lock_dir)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?;
    if let Ok(ref r) = res {
        failed_trash.record_item(r);
    }
    res
}

#[tauri::command]
#[allow(non_snake_case)]
async fn trash_large_files(
    app: AppHandle,
    paths: Option<Vec<String>>,
    file_paths: Option<Vec<String>>,
    filePaths: Option<Vec<String>>,
) -> Result<DisposalSummary, String> {
    let journal = get_journal(&app)?;
    let failed_trash = app.state::<FailedTrashRegistry>().inner().clone();
    let effective_paths = paths.or(file_paths).or(filePaths).unwrap_or_default();
    let lock_dir = get_lock_dir(&app)?;
    let res = tauri::async_runtime::spawn_blocking(move || {
        let platform = get_platform();
        let pbs: Vec<PathBuf> = effective_paths.into_iter().map(PathBuf::from).collect();
        let app_clone = app.clone();
        LargeFilesScanner::trash_large_files_with_progress(
            &pbs,
            &platform,
            &journal,
            &lock_dir,
            move |idx, total, path, freed| {
                let pct = if total > 0 {
                    ((idx as f32 / total as f32) * 100.0) as u8
                } else {
                    100
                };
                let _ = app_clone.emit(
                    "scan-progress",
                    AppScanProgress {
                        scan_type: "disposal".to_string(),
                        stage: format!("Recycling large files ({}/{})", idx, total),
                        percent: pct.min(100),
                        items_scanned: idx as u64,
                        current_path: path.to_string_lossy().to_string(),
                        bytes_found: freed,
                        is_complete: idx >= total,
                    },
                );
            },
        )
        .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?;
    if let Ok(ref r) = res {
        failed_trash.record_summary(r);
    }
    res
}

#[tauri::command]
#[allow(non_snake_case, clippy::too_many_arguments)]
async fn scan_duplicate_files(
    app: AppHandle,
    cancel_state: State<'_, ScanCancellationState>,
    roots: Option<Vec<String>>,
    root: Option<String>,
    root_path: Option<String>,
    rootPath: Option<String>,
    min_size_bytes: Option<u64>,
    minSizeBytes: Option<u64>,
) -> Result<DuplicateScanResult, String> {
    let mut targets = roots.unwrap_or_default();
    if targets.is_empty() {
        if let Some(r) = root.or(root_path).or(rootPath) {
            targets.push(r);
        }
    }
    if targets.is_empty() {
        targets.push("C:\\".to_string());
    }

    let app_data = app.path().app_data_dir().ok();
    let effective_min = min_size_bytes.or(minSizeBytes).unwrap_or(1024 * 1024);
    let cancel = CancellationToken::new();
    {
        let mut guard = cancel_state.0.lock().unwrap();
        *guard = Some(cancel.clone());
    }
    let cancel_for_task = cancel.clone();
    let app_emitter = app.clone();
    let res = tauri::async_runtime::spawn_blocking(move || {
        let platform = get_platform();
        let pbs: Vec<PathBuf> = targets.into_iter().map(PathBuf::from).collect();
        let cache = app_data.as_ref().and_then(|p| {
            freemydisk_core::storage::duplicates::HashCache::open(&p.join("hash_cache.db")).ok()
        });

        let app_emit_cb = app_emitter.clone();
        DuplicateDetector::scan_duplicates_with_progress(
            &pbs,
            effective_min,
            &platform,
            cache.as_ref(),
            &cancel_for_task,
            |stage, pct, items_scanned, current_path, bytes_found| {
                let _ = app_emit_cb.emit(
                    "scan-progress",
                    AppScanProgress {
                        scan_type: "duplicates".to_string(),
                        stage: stage.to_string(),
                        percent: pct,
                        items_scanned,
                        current_path: current_path.to_string_lossy().to_string(),
                        bytes_found,
                        is_complete: pct >= 100,
                    },
                );
            },
        )
        .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?;

    {
        let mut guard = cancel_state.0.lock().unwrap();
        *guard = None;
    }

    if let Ok(ref result) = res {
        let _ = app.emit(
            "scan-progress",
            AppScanProgress {
                scan_type: "duplicates".to_string(),
                stage: "Duplicate scan complete".to_string(),
                percent: 100,
                items_scanned: result.total_duplicate_files as u64,
                current_path: String::new(),
                bytes_found: result.total_potential_savings,
                is_complete: true,
            },
        );
    }

    trim_process_working_set();
    res
}

#[tauri::command]
#[allow(non_snake_case)]
async fn trash_duplicate_folders(
    app: AppHandle,
    paths: Option<Vec<String>>,
    folder_paths: Option<Vec<String>>,
    folderPaths: Option<Vec<String>>,
) -> Result<DisposalSummary, String> {
    let journal = get_journal(&app)?;
    let failed_trash = app.state::<FailedTrashRegistry>().inner().clone();
    let effective_paths = paths.or(folder_paths).or(folderPaths).unwrap_or_default();
    let lock_dir = get_lock_dir(&app)?;
    let res = tauri::async_runtime::spawn_blocking(move || {
        let platform = get_platform();
        let cancel = CancellationToken::new();

        let pbs: Vec<PathBuf> = effective_paths.into_iter().map(PathBuf::from).collect();
        DuplicateDetector::batch_trash_duplicate_folders(
            &pbs, &platform, &journal, &lock_dir, &cancel,
        )
        .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?;
    if let Ok(ref r) = res {
        failed_trash.record_summary(r);
    }
    res
}

#[tauri::command]
#[allow(non_snake_case)]
async fn scan_project_artifacts(
    app: AppHandle,
    cancel_state: State<'_, ScanCancellationState>,
    roots: Option<Vec<String>>,
    min_size_bytes: Option<u64>,
    minSizeBytes: Option<u64>,
) -> Result<freemydisk_core::cleanup::project_artifacts::ProjectArtifactScanResult, String> {
    let effective_min = min_size_bytes.or(minSizeBytes);
    let target_roots: Vec<PathBuf> = roots
        .unwrap_or_default()
        .into_iter()
        .map(PathBuf::from)
        .collect();

    let cancel = CancellationToken::new();
    {
        let mut guard = cancel_state.0.lock().unwrap();
        *guard = Some(cancel.clone());
    }
    let cancel_for_task = cancel.clone();

    let _ = app.emit(
        "scan-progress",
        AppScanProgress {
            scan_type: "projects".to_string(),
            stage: "Scanning developer artifacts (node_modules, target, build)...".to_string(),
            percent: 25,
            items_scanned: 0,
            current_path: String::new(),
            bytes_found: 0,
            is_complete: false,
        },
    );

    let res = tauri::async_runtime::spawn_blocking(move || {
        freemydisk_core::cleanup::project_artifacts::ProjectArtifactScanner::scan(
            &target_roots,
            effective_min,
            &cancel_for_task,
        )
        .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?;

    {
        let mut guard = cancel_state.0.lock().unwrap();
        *guard = None;
    }

    if let Ok(ref result) = res {
        let _ = app.emit(
            "scan-progress",
            AppScanProgress {
                scan_type: "projects".to_string(),
                stage: "Project artifact scan completed".to_string(),
                percent: 100,
                items_scanned: result.total_artifacts as u64,
                current_path: String::new(),
                bytes_found: result.total_reclaimable_bytes,
                is_complete: true,
            },
        );
    }

    trim_process_working_set();
    res
}

#[tauri::command]
#[allow(non_snake_case)]
async fn clean_project_artifacts(
    app: AppHandle,
    artifact_paths: Option<Vec<String>>,
    artifactPaths: Option<Vec<String>>,
) -> Result<DisposalSummary, String> {
    let journal = get_journal(&app)?;
    let failed_trash = app.state::<FailedTrashRegistry>().inner().clone();
    let paths = artifact_paths.or(artifactPaths).unwrap_or_default();
    let lock_dir = get_lock_dir(&app)?;

    let res = tauri::async_runtime::spawn_blocking(move || {
        let platform = get_platform();
        let cancel = CancellationToken::new();

        let path_bufs: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
        freemydisk_core::cleanup::project_artifacts::ProjectArtifactScanner::clean_artifacts(
            &path_bufs, &platform, &journal, &lock_dir, &cancel,
        )
        .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?;
    if let Ok(ref r) = res {
        failed_trash.record_summary(r);
    }
    res
}

#[tauri::command]
#[allow(non_snake_case)]
async fn trash_duplicate_files(
    app: AppHandle,
    paths: Option<Vec<String>>,
    file_paths: Option<Vec<String>>,
    filePaths: Option<Vec<String>>,
    groups: Option<Vec<DuplicateGroup>>,
) -> Result<DisposalSummary, String> {
    let journal = get_journal(&app)?;
    let failed_trash = app.state::<FailedTrashRegistry>().inner().clone();
    let effective_paths = paths.or(file_paths).or(filePaths);
    let lock_dir = get_lock_dir(&app)?;
    let res = tauri::async_runtime::spawn_blocking(move || {
        let platform = get_platform();
        let cancel = CancellationToken::new();

        if let Some(p_list) = effective_paths {
            let items: Vec<freemydisk_core::cleanup::plan::CleanupPlanItem> = p_list
                .into_iter()
                .map(|p| {
                    let pb = PathBuf::from(&p);
                    let size = pb.metadata().map(|m| m.len()).unwrap_or(0);
                    let canon = dunce::canonicalize(&pb)
                        .unwrap_or_else(|_| dunce::simplified(&pb).to_path_buf());
                    freemydisk_core::cleanup::plan::CleanupPlanItem {
                        original_path: pb,
                        canonical_path: canon,
                        size_bytes: size,
                        is_dir: false,
                        matched_rules: vec!["duplicate_finder".to_string()],
                        default_action: "trash".to_string(),
                        verified_rebuildable: false,
                        protect_subpaths: Vec::new(),
                        risk: "safe".to_string(),
                    }
                })
                .collect();

            let app_clone = app.clone();
            DisposalEngine::execute_plan_with_progress(
                &items,
                &platform,
                &journal,
                &lock_dir,
                true,
                &cancel,
                move |idx, total, path, freed| {
                    let pct = if total > 0 {
                        ((idx as f32 / total as f32) * 100.0) as u8
                    } else {
                        100
                    };
                    let _ = app_clone.emit(
                        "scan-progress",
                        AppScanProgress {
                            scan_type: "disposal".to_string(),
                            stage: format!("Recycling duplicate files ({}/{})", idx, total),
                            percent: pct.min(100),
                            items_scanned: idx as u64,
                            current_path: path.to_string_lossy().to_string(),
                            bytes_found: freed,
                            is_complete: idx >= total,
                        },
                    );
                },
            )
            .map_err(|e| e.to_string())
        } else if let Some(g_list) = groups {
            DuplicateDetector::batch_trash_duplicates(
                &g_list, &platform, &journal, &lock_dir, &cancel,
            )
            .map_err(|e| e.to_string())
        } else {
            Ok(DisposalSummary {
                session_id: uuid::Uuid::new_v4().to_string(),
                total_requested_items: 0,
                successful_items: 0,
                failed_items: 0,
                total_freed_bytes: 0,
                results: Vec::new(),
                failed_trash_paths: Vec::new(),
            })
        }
    })
    .await
    .map_err(|e| e.to_string())?;
    if let Ok(ref r) = res {
        failed_trash.record_summary(r);
    }
    res
}

#[tauri::command]
fn get_startup_items() -> Result<Vec<StartupItem>, String> {
    StartupService::new().list_startup_items()
}

#[tauri::command]
#[allow(non_snake_case)]
async fn toggle_startup_item(
    id: Option<String>,
    item_id: Option<String>,
    itemId: Option<String>,
    enable: bool,
) -> Result<bool, String> {
    let target_id = id
        .or(item_id)
        .or(itemId)
        .ok_or_else(|| "Missing startup item id".to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        StartupService::new()
            .toggle_startup_item(&target_id, enable)
            .map(|_| true)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
#[allow(non_snake_case)]
async fn delete_startup_item(
    id: Option<String>,
    item_id: Option<String>,
    itemId: Option<String>,
) -> Result<bool, String> {
    let target_id = id
        .or(item_id)
        .or(itemId)
        .ok_or_else(|| "Missing startup item id".to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        StartupService::new()
            .delete_startup_item(&target_id)
            .map(|_| true)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn get_installed_applications() -> Result<Vec<InstalledAppInfo>, String> {
    tauri::async_runtime::spawn_blocking(|| ApplicationService::new().list_applications())
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn scan_application_leftovers(app: AppHandle) -> Result<Vec<ApplicationLeftover>, String> {
    let scanned = app.state::<LeftoverScanRegistry>().inner().clone();
    let res = tauri::async_runtime::spawn_blocking(|| ApplicationService::new().scan_leftovers())
        .await
        .map_err(|e| e.to_string())?;
    if let Ok(ref items) = res {
        scanned.record(items.iter().map(|i| i.path.as_str()));
    }
    trim_process_working_set();
    res
}

#[tauri::command]
#[allow(non_snake_case)]
async fn launch_uninstaller(app_id: Option<String>, appId: Option<String>) -> Result<(), String> {
    let id = app_id
        .or(appId)
        .ok_or_else(|| "Missing application id".to_string())?;
    tauri::async_runtime::spawn_blocking(move || ApplicationService::new().launch_uninstaller(&id))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
#[allow(non_snake_case)]
async fn launch_app_uninstaller(
    app_id: Option<String>,
    appId: Option<String>,
) -> Result<(), String> {
    launch_uninstaller(app_id, appId).await
}

#[tauri::command]
async fn get_uwp_applications() -> Result<Vec<freemydisk_core::applications::UwpAppInfo>, String> {
    tauri::async_runtime::spawn_blocking(|| ApplicationService::new().list_uwp_applications())
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
#[allow(non_snake_case)]
async fn uninstall_uwp_application(
    package_full_name: Option<String>,
    packageFullName: Option<String>,
) -> Result<bool, String> {
    let pkg_name = package_full_name
        .or(packageFullName)
        .ok_or_else(|| "Missing package full name".to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        ApplicationService::new().uninstall_uwp_application(&pkg_name)
    })
    .await
    .map_err(|e| e.to_string())?
    .map(|_| true)
}

#[tauri::command]
async fn scan_deep_leftovers(
    app: AppHandle,
) -> Result<Vec<freemydisk_core::applications::LeftoverGroup>, String> {
    let scanned = app.state::<LeftoverScanRegistry>().inner().clone();
    let res = tauri::async_runtime::spawn_blocking(|| {
        let _bg_guard = freemydisk_platform::io_priority::BackgroundExecutionGuard::enter();
        ApplicationService::new().scan_deep_leftovers()
    })
    .await
    .map_err(|e| e.to_string())?;
    if let Ok(ref groups) = res {
        scanned.record_groups(groups);
    }
    trim_process_working_set();
    res
}

#[tauri::command]
#[allow(non_snake_case)]
async fn clean_leftovers_safe(
    app: AppHandle,
    paths: Vec<String>,
    include_registry: Option<bool>,
    includeRegistry: Option<bool>,
) -> Result<freemydisk_core::applications::LeftoverCleanSummary, String> {
    let journal = get_journal(&app)?;
    let incl_reg = include_registry.or(includeRegistry).unwrap_or(true);
    let scanned = app.state::<LeftoverScanRegistry>().inner().clone();
    let (known, unknown) = scanned.partition(&paths);
    if !unknown.is_empty() {
        log::warn!(
            "Rejected {} leftover item(s) that were not produced by a scan",
            unknown.len()
        );
    }
    if known.is_empty() {
        return Err("Run a leftover scan before cleaning.".to_string());
    }

    let lock_dir = get_lock_dir(&app)?;
    let res = tauri::async_runtime::spawn_blocking(move || {
        let _bg_guard = freemydisk_platform::io_priority::BackgroundExecutionGuard::enter();
        let platform = get_platform();
        freemydisk_core::applications::LeftoverScanner::clean_items(
            &known, incl_reg, &platform, &journal, &lock_dir,
        )
    })
    .await
    .map_err(|e| e.to_string())?;
    if let Ok(ref summary) = res {
        let failed: HashSet<String> = summary.failed.iter().map(|f| f.to_lowercase()).collect();
        scanned.forget(paths.iter().filter(|p| !failed.contains(&p.to_lowercase())));
    }
    trim_process_working_set();
    res
}

#[tauri::command]
#[allow(non_snake_case)]
async fn terminate_app_processes(
    app_name: Option<String>,
    appName: Option<String>,
) -> Result<usize, String> {
    let name = app_name
        .or(appName)
        .ok_or_else(|| "Missing app name".to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        freemydisk_core::applications::ProcessController::terminate_app_processes(&name)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
#[allow(non_snake_case)]
async fn uninstall_and_scan(
    app: AppHandle,
    app_id: Option<String>,
    appId: Option<String>,
) -> Result<freemydisk_core::applications::UninstallResult, String> {
    let target = app_id
        .or(appId)
        .ok_or_else(|| "Missing app id".to_string())?;
    let scanned = app.state::<LeftoverScanRegistry>().inner().clone();
    let res = tauri::async_runtime::spawn_blocking(move || {
        ApplicationService::new().uninstall_and_scan(&target)
    })
    .await
    .map_err(|e| e.to_string())?;
    if let Ok(freemydisk_core::applications::UninstallResult {
        leftovers: Some(ref group),
        ..
    }) = res
    {
        scanned.record_groups(std::slice::from_ref(group));
    }
    res
}

#[tauri::command]
#[allow(non_snake_case)]
async fn launch_silent_uninstaller(
    app_id: Option<String>,
    appId: Option<String>,
) -> Result<(), String> {
    let id = app_id
        .or(appId)
        .ok_or_else(|| "Missing application id".to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        ApplicationService::new().launch_silent_uninstaller(&id)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
#[allow(non_snake_case)]
async fn uninstall_and_scan_silent(
    app: AppHandle,
    app_id: Option<String>,
    appId: Option<String>,
) -> Result<freemydisk_core::applications::UninstallResult, String> {
    let target = app_id
        .or(appId)
        .ok_or_else(|| "Missing app id".to_string())?;
    let scanned = app.state::<LeftoverScanRegistry>().inner().clone();
    let res = tauri::async_runtime::spawn_blocking(move || {
        ApplicationService::new().uninstall_and_scan_silent(&target)
    })
    .await
    .map_err(|e| e.to_string())?;
    if let Ok(freemydisk_core::applications::UninstallResult {
        leftovers: Some(ref group),
        ..
    }) = res
    {
        scanned.record_groups(std::slice::from_ref(group));
    }
    res
}

#[tauri::command]
async fn get_file_locking_processes(
    path: String,
) -> Result<Vec<freemydisk_platform::RawRunningProcess>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        ApplicationService::new().get_locking_processes(std::path::Path::new(&path))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn refresh_desktop_shell() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(|| {
        let platform = get_platform();
        platform.refresh_shell().map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn get_maintenance_tasks() -> Vec<MaintenanceTask> {
    MaintenanceService::new().list_tasks()
}

#[tauri::command]
async fn execute_maintenance_task(task_id: String) -> MaintenanceResult {
    let tid = task_id.clone();
    tauri::async_runtime::spawn_blocking(move || MaintenanceService::new().execute_task(&tid))
        .await
        .unwrap_or_else(|e| MaintenanceResult {
            task_id,
            success: false,
            message: format!("Execution failed: {}", e),
            duration_ms: 0,
        })
}

#[tauri::command]
#[allow(non_snake_case)]
async fn run_maintenance_task(
    task_id: Option<String>,
    taskId: Option<String>,
) -> MaintenanceResult {
    let tid = task_id.or(taskId).unwrap_or_default();
    execute_maintenance_task(tid).await
}

#[tauri::command]
fn get_pending_reboot_deletions(
) -> Result<Vec<freemydisk_platform::traits::PendingRebootDeletion>, String> {
    list_pending_reboot_deletions()
}

#[tauri::command]
fn cancel_reboot_deletion(path: String) -> Result<(), String> {
    cancel_pending_reboot_deletion(path)
}

#[tauri::command]
fn is_elevated_process() -> bool {
    freemydisk_platform::traits::PlatformElevation::is_elevated(&get_platform())
}

#[tauri::command]
async fn execute_elevated_action(
    operation: String,
    payload: String,
) -> Result<freemydisk_core::system_maintenance::ElevatedResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        freemydisk_core::system_maintenance::ElevatedClient::execute_action(&operation, &payload)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn execute_all_recommended_maintenance() -> Vec<MaintenanceResult> {
    tauri::async_runtime::spawn_blocking(|| MaintenanceService::new().execute_all_recommended())
        .await
        .unwrap_or_default()
}

#[tauri::command]
async fn execute_emergency_rescue(
) -> Result<freemydisk_core::system_maintenance::EmergencyRescueResult, String> {
    tauri::async_runtime::spawn_blocking(|| MaintenanceService::new().execute_emergency_rescue())
        .await
        .map_err(|e| e.to_string())?
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecycleBinStatus {
    pub total_bytes: u64,
    pub item_count: u64,
}

#[tauri::command]
#[allow(non_snake_case)]
async fn get_recycle_bin_status(
    drive: Option<String>,
    drivePath: Option<String>,
) -> Result<RecycleBinStatus, String> {
    let target = drive.or(drivePath);
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "windows")]
        {
            use freemydisk_platform::windows::maintenance::WindowsSystemMaintenanceHandler;
            let (total_bytes, item_count) =
                WindowsSystemMaintenanceHandler::query_recycle_bin_for_drive(target.as_deref())
                    .unwrap_or((0, 0));
            Ok(RecycleBinStatus {
                total_bytes,
                item_count,
            })
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = target;
            Ok(RecycleBinStatus {
                total_bytes: 0,
                item_count: 0,
            })
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
#[allow(non_snake_case)]
async fn empty_recycle_bin(
    drive: Option<String>,
    drivePath: Option<String>,
) -> Result<u64, String> {
    let target = drive.or(drivePath);
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "windows")]
        {
            use freemydisk_platform::windows::maintenance::WindowsSystemMaintenanceHandler;
            WindowsSystemMaintenanceHandler::empty_recycle_bin_for_drive(target.as_deref())
                .map_err(|e| e.to_string())
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = target;
            Ok(0)
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn scan_privacy_data(app: tauri::AppHandle) -> Result<PrivacyScanResult, String> {
    let res = tauri::async_runtime::spawn_blocking(move || {
        let app_clone = app.clone();
        PrivacyService::new().scan_privacy_items_with_progress(move |progress| {
            let _ = app_clone.emit("scan-progress", progress);
        })
    })
    .await
    .map_err(|e| e.to_string())?;
    trim_process_working_set();
    res
}

#[tauri::command]
#[allow(non_snake_case)]
async fn clean_privacy_data(
    app: tauri::AppHandle,
    item_ids: Option<Vec<String>>,
    itemIds: Option<Vec<String>>,
    whitelist_domains: Option<Vec<String>>,
    whitelistDomains: Option<Vec<String>>,
) -> Result<u64, String> {
    let ids = item_ids.or(itemIds).unwrap_or_default();
    let domains = whitelist_domains.or(whitelistDomains).unwrap_or_default();
    let res = tauri::async_runtime::spawn_blocking(move || {
        let app_clone = app.clone();
        PrivacyService::new().clean_privacy_items_with_progress(&ids, &domains, move |progress| {
            let _ = app_clone.emit("scan-progress", progress);
        })
    })
    .await
    .map_err(|e| e.to_string())?;
    trim_process_working_set();
    res
}

#[tauri::command]
async fn close_running_browsers() -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let platform = get_platform();
        let target_exes = [
            "chrome.exe",
            "msedge.exe",
            "brave.exe",
            "vivaldi.exe",
            "arc.exe",
            "chromium.exe",
            "firefox.exe",
            "librewolf.exe",
            "floorp.exe",
            "waterfox.exe",
            "opera.exe",
            "operagx.exe",
        ];
        if let Ok(procs) = platform.list_running_processes() {
            let mut closed = 0;
            for p in procs {
                let p_name = p.name.to_lowercase();
                if target_exes.iter().any(|&t| t == p_name)
                    && platform.terminate_process(p.pid).is_ok()
                {
                    closed += 1;
                }
            }
            Ok(closed)
        } else {
            Err("Failed to query running processes".to_string())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn get_optimization_overview() -> Result<OptimizationOverview, String> {
    OptimizationService::new().get_overview()
}

#[tauri::command]
async fn toggle_hibernation(enable: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || OptimizationService::new().set_hibernation(enable))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn toggle_storage_sense(enable: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        OptimizationService::new().set_storage_sense(enable)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn clean_delivery_cache() -> Result<u64, String> {
    tauri::async_runtime::spawn_blocking(|| OptimizationService::new().clean_delivery_cache())
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
#[allow(non_snake_case)]
async fn set_explorer_setting(
    setting_key: Option<String>,
    settingKey: Option<String>,
    enable: bool,
) -> Result<(), String> {
    let key = setting_key
        .or(settingKey)
        .ok_or_else(|| "Missing explorer setting key".to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        OptimizationService::new().set_explorer_setting(&key, enable)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn get_system_vitals() -> Result<freemydisk_platform::traits::SystemVitals, String> {
    let platform = get_platform();
    platform.get_system_vitals().map_err(|e| e.to_string())
}

#[tauri::command]
async fn scan_ai_models() -> Result<Vec<AiModelInfo>, String> {
    let res = tauri::async_runtime::spawn_blocking(AiModelAnalyzer::scan)
        .await
        .map_err(|e| e.to_string())?;
    trim_process_working_set();
    Ok(res)
}

#[tauri::command]
async fn clean_ai_model(path: String) -> Result<u64, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let platform = get_platform();
        AiModelAnalyzer::clean_model(&path, &platform).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn scan_rust_toolchains() -> Result<RustToolchainScanResult, String> {
    let res = tauri::async_runtime::spawn_blocking(RustToolchainCleaner::scan)
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    trim_process_working_set();
    Ok(res)
}

#[tauri::command]
async fn clean_rust_toolchain(toolchain: String, force: Option<bool>) -> Result<u64, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let platform = get_platform();
        let force_active = force.unwrap_or(false);
        RustToolchainCleaner::clean_toolchain(&toolchain, force_active, &platform)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn scan_conda_cache() -> Result<CondaCacheInfo, String> {
    let res = tauri::async_runtime::spawn_blocking(CondaCleaner::scan)
        .await
        .map_err(|e| e.to_string())?;
    trim_process_working_set();
    Ok(res)
}

#[tauri::command]
async fn clean_conda_cache() -> Result<u64, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let platform = get_platform();
        CondaCleaner::clean_cache(&platform).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

pub fn run() {
    // 0. Install Global Panic Hook for Crash Recovery and symbolicated diagnostics (§12.1)
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |panic_info| {
        let backtrace = std::backtrace::Backtrace::force_capture();
        let payload = if let Some(s) = panic_info.payload().downcast_ref::<&str>() {
            s.to_string()
        } else if let Some(s) = panic_info.payload().downcast_ref::<String>() {
            s.clone()
        } else {
            "Unknown panic".to_string()
        };
        let location = panic_info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "unknown location".to_string());

        // 1. Emergency flush of the WAL journal the app is actually using
        if let Some(journal) = PANIC_JOURNAL.get() {
            let _ = journal.emergency_flush();
        }

        // 2. Save structured symbolicated crash dump report to %LOCALAPPDATA%\FreeMyDisk\crash_reports
        let report = freemydisk_core::filesystem::crash_report::CrashDumpReport::new(
            payload,
            location,
            format!("{:#?}", backtrace),
        );
        let _ = report.save_to_disk();

        default_hook(panic_info);
    }));

    // 1. Cap worker threads (1..=4) to prevent CPU starvation and thread stack bloat on low-spec/4GB machines
    freemydisk_core::init_performance_profile();

    // 2. Instruct mimalloc to release freed memory pages immediately back to the OS
    std::env::set_var("MIMALLOC_PURGE_DELAY", "0");
    std::env::set_var("MIMALLOC_ARENA_EAGER_COMMIT", "0");

    // 3. Configure WebView2 (Chromium engine) for minimal RAM footprint
    if std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").is_err() {
        std::env::set_var(
            "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
            "--renderer-process-limit=1 \
             --js-flags=\"--max-old-space-size=128 --optimize-for-size\" \
             --disable-gpu-shader-disk-cache \
             --disable-features=Translate,OptimizationHints,MediaRouter,CalculateNativeWinOcclusion \
             --disable-background-networking \
             --disable-component-update",
        );
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let journal = app
                .path()
                .app_data_dir()
                .map_err(|e| e.to_string())
                .and_then(|dir| {
                    CrashRecoveryJournal::open(&dir.join("journal.db")).map_err(|e| e.to_string())
                });
            match &journal {
                Ok(j) => {
                    let _ = PANIC_JOURNAL.set(j.clone());
                }
                Err(e) => log::error!("Crash recovery journal unavailable: {}", e),
            }
            app.manage(JournalState(journal));

            // Self-Healing on Boot (§12.3):
            // Check dirty shutdown and auto-remediate stranded staging files
            if let Ok(journal) = get_journal(app.handle()) {
                if let Ok(results) = journal.self_heal_on_boot() {
                    if !results.is_empty() {
                        log::info!(
                            "Boot self-healing restored {} stranded files",
                            results.len()
                        );
                    }
                }
            }
            if let Some(window) = app.get_webview_window("main") {
                if let Some(icon) = app.default_window_icon() {
                    let _ = window.set_icon(icon.clone());
                }
                let _ = window.show();
                let _ = window.set_focus();

                // Handle window close cleanly & auto-trim working set on window blur (focus lost)
                window.on_window_event(|event| match event {
                    tauri::WindowEvent::CloseRequested { .. } => {
                        std::process::exit(0);
                    }
                    tauri::WindowEvent::Focused(false) => {
                        trim_process_working_set();
                    }
                    _ => {}
                });

                // Spawn periodic background working-set trimmer every 60s
                std::thread::spawn(|| loop {
                    std::thread::sleep(std::time::Duration::from_secs(60));
                    trim_process_working_set();
                });

                // Initial working-set trim 3 seconds after startup once UI has loaded
                std::thread::spawn(|| {
                    std::thread::sleep(std::time::Duration::from_secs(3));
                    trim_process_working_set();
                });
            }
            Ok(())
        })
        .manage(ScanCancellationState::default())
        .manage(FailedTrashRegistry::default())
        .manage(LeftoverScanRegistry::default())
        .invoke_handler(tauri::generate_handler![
            trim_process_memory,
            get_power_state,
            get_virtualization_overview,
            compact_wsl_distribution,
            docker_prune,
            get_recovery_status,
            acknowledge_recovery_banner,
            list_pending_reboot_deletions,
            cancel_pending_reboot_deletion,
            scan_cleanup_rules,
            execute_cleanup_plan,
            execute_cleanup_rules,
            retry_failed_trash,
            force_delete_permanently,
            get_storage_volumes,
            scan_storage_tree,
            scan_heavy_folders,
            cancel_active_scan,
            get_application_icons,
            export_storage_scan,
            scan_large_files,
            trash_large_file,
            trash_large_files,
            scan_duplicate_files,
            trash_duplicate_files,
            trash_duplicate_folders,
            scan_project_artifacts,
            clean_project_artifacts,
            get_startup_items,
            toggle_startup_item,
            delete_startup_item,
            get_installed_applications,
            get_uwp_applications,
            uninstall_uwp_application,
            scan_application_leftovers,
            scan_deep_leftovers,
            clean_leftovers_safe,
            terminate_app_processes,
            uninstall_and_scan,
            launch_app_uninstaller,
            launch_uninstaller,
            launch_silent_uninstaller,
            uninstall_and_scan_silent,
            get_file_locking_processes,
            refresh_desktop_shell,
            get_maintenance_tasks,
            execute_maintenance_task,
            execute_all_recommended_maintenance,
            execute_emergency_rescue,
            scan_privacy_data,
            clean_privacy_data,
            close_running_browsers,
            get_optimization_overview,
            toggle_hibernation,
            toggle_storage_sense,
            clean_delivery_cache,
            set_explorer_setting,
            get_system_vitals,
            get_cleanup_history,
            clear_cleanup_history,
            scan_directory_storage,
            run_maintenance_task,
            get_pending_reboot_deletions,
            cancel_reboot_deletion,
            close_locking_process,
            close_all_locking_processes,
            get_recycle_bin_status,
            empty_recycle_bin,
            log_frontend_exception,
            check_disk_space_guard,
            generate_diagnostic_bundle,
            scan_ai_models,
            clean_ai_model,
            scan_rust_toolchains,
            clean_rust_toolchain,
            scan_conda_cache,
            clean_conda_cache,
            is_elevated_process,
            execute_elevated_action,
            remediate_interrupted_session,
            force_terminate_uninstaller,
            track_uninstaller_watchdog,
        ])
        .run(tauri::generate_context!())
        .expect("error while running FreeMyDisk application");
}
