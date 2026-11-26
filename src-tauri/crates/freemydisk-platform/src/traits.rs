use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum PlatformError {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Trash unavailable: {0}")]
    TrashUnavailable(String),

    #[error("Lock busy: another cleanup operation is currently running")]
    LockBusy,

    #[error("Elevation required: {0}")]
    ElevationRequired(String),

    #[error("Permission denied: {0}")]
    PermissionDenied(String),

    #[error("Platform operation failed: {0}")]
    OperationFailed(String),

    #[error("Unsupported on this platform: {0}")]
    Unsupported(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct FileIdentity {
    pub device_id: u64,
    pub file_index: u64,
    pub link_count: u32,
    pub is_reparse_or_symlink: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingRebootDeletion {
    pub path: PathBuf,
    pub size_bytes: Option<u64>,
    pub scheduled_at: Option<u64>,
    pub holding_process: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StorageVolumeInfo {
    pub mount_point: String,
    pub volume_name: String,
    pub total_bytes: u64,
    pub available_bytes: u64,
    pub file_system: String,
    pub is_removable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SystemVitals {
    pub total_ram_bytes: u64,
    pub available_ram_bytes: u64,
    pub used_ram_bytes: u64,
    pub memory_load_percent: u32,
    pub os_name: String,
    pub computer_name: String,
    pub cpu_cores: usize,
}

pub trait PlatformFilesystem: Send + Sync {
    /// Moves path to the OS Recycle Bin / Trash.
    /// NEVER falls back to permanent delete if this returns an error.
    fn trash_path(&self, path: &Path) -> Result<(), PlatformError>;

    /// Detects whether path is a cloud-sync placeholder (OneDrive, iCloud)
    /// where reading content would trigger a network download.
    fn is_cloud_placeholder(&self, path: &Path) -> Result<bool, PlatformError>;

    /// Retrieves unique hardware/filesystem inode identity for cycle and hardlink/clone detection.
    fn get_file_identity(&self, path: &Path) -> Result<FileIdentity, PlatformError>;

    /// Acquires an exclusive kernel-level file lock (fs4 / LockFileEx / flock).
    /// Releases automatically if process crashes or is forcefully terminated.
    fn acquire_cross_process_lock(
        &self,
        lock_path: &Path,
    ) -> Result<Box<dyn std::any::Any + Send + Sync>, PlatformError>;

    /// Lists mounted storage volumes.
    fn list_volumes(&self) -> Result<Vec<StorageVolumeInfo>, PlatformError>;

    /// Signals the OS Shell (e.g. Windows Explorer) to refresh icon and thumbnail caches without process termination.
    fn refresh_shell(&self) -> Result<(), PlatformError> {
        Ok(())
    }
}

pub trait PlatformRebootQueue: Send + Sync {
    /// Lists all files scheduled for deletion on next system restart.
    fn list_pending_deletions(&self) -> Result<Vec<PendingRebootDeletion>, PlatformError>;

    /// Cancels a pending reboot deletion, removing it from registry / launch queue.
    fn cancel_pending_deletion(&self, path: &Path) -> Result<(), PlatformError>;
}

pub trait PlatformElevation: Send + Sync {
    fn is_elevated(&self) -> bool;
}

pub trait PlatformIoPriority: Send + Sync {
    fn set_background_idle_priority(&self) -> Result<(), PlatformError>;
    fn set_below_normal_priority(&self) -> Result<(), PlatformError>;
    fn set_normal_priority(&self) -> Result<(), PlatformError>;
    fn seconds_since_last_input(&self) -> Result<u64, PlatformError>;
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RawStartupEntry {
    pub id: String,
    pub name: String,
    pub command: String,
    pub location: String,
    pub enabled: bool,
    pub target_path: Option<String>,
}

pub trait PlatformStartup: Send + Sync {
    fn list_startup_entries(&self) -> Result<Vec<RawStartupEntry>, PlatformError>;
    fn set_startup_entry_state(&self, entry_id: &str, enable: bool) -> Result<(), PlatformError>;
    fn delete_startup_entry(&self, entry_id: &str) -> Result<(), PlatformError>;
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RawInstalledApp {
    pub id: String,
    pub name: String,
    pub publisher: Option<String>,
    pub display_version: Option<String>,
    pub install_location: Option<String>,
    pub uninstall_string: Option<String>,
    pub estimated_size_bytes: Option<u64>,
    pub install_date: Option<String>,
    pub display_icon: Option<String>,
    pub icon_data: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RawRunningProcess {
    pub pid: u32,
    pub name: String,
    pub exe_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RawUwpApp {
    pub name: String,
    pub display_name: String,
    pub publisher: Option<String>,
    pub package_full_name: String,
    pub install_location: Option<String>,
    pub version: Option<String>,
    pub estimated_size_bytes: Option<u64>,
    pub icon_path: Option<String>,
    pub icon_data_url: Option<String>,
}

pub trait PlatformApplications: Send + Sync {
    fn list_installed_apps(&self) -> Result<Vec<RawInstalledApp>, PlatformError>;
    fn list_running_processes(&self) -> Result<Vec<RawRunningProcess>, PlatformError>;
    fn terminate_process(&self, pid: u32) -> Result<(), PlatformError>;
    fn launch_uninstaller(&self, uninstall_string: &str) -> Result<(), PlatformError>;
    fn launch_silent_uninstaller(
        &self,
        uninstall_string: &str,
        _install_dir: Option<&str>,
    ) -> Result<(), PlatformError> {
        self.launch_uninstaller(uninstall_string)
    }
    fn list_uwp_apps(&self) -> Result<Vec<RawUwpApp>, PlatformError>;
    fn uninstall_uwp_app(&self, package_full_name: &str) -> Result<(), PlatformError>;
    fn get_locking_processes(&self, _path: &Path) -> Result<Vec<RawRunningProcess>, PlatformError> {
        Ok(Vec::new())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MaintenanceTaskKind {
    IconCacheReset,
    DnsCacheFlush,
    SearchIndexRebuild,
    WindowsUpdateCacheCleanup,
    NetworkStackReset,
    PrintQueuePurge,
    AudioServiceReset,
    TimeServiceSync,
    StoreCacheReset,
    SystemIntegrityRepair,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmergencyRescueSummary {
    pub total_bytes_reclaimed: u64,
    pub hibernation_disabled: bool,
    pub recycle_bin_emptied: bool,
    pub temp_cleaned_bytes: u64,
    pub wsl_shutdown: bool,
    pub actions_performed: Vec<String>,
}

/// How one Emergency Rescue step ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RescueStepStatus {
    Done,
    Skipped,
    Failed,
}

/// Result of one Emergency Rescue step, shown to the user as one line.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RescueStepOutcome {
    /// Stable step id: `recycle_bin`, `temp_files`, `hibernation` or `wsl`.
    pub step: String,
    pub status: RescueStepStatus,
    pub bytes_reclaimed: u64,
    pub message: String,
}

impl RescueStepOutcome {
    pub fn done(step: &str, bytes_reclaimed: u64, message: impl Into<String>) -> Self {
        Self {
            step: step.to_string(),
            status: RescueStepStatus::Done,
            bytes_reclaimed,
            message: message.into(),
        }
    }

    pub fn skipped(step: &str, message: impl Into<String>) -> Self {
        Self {
            step: step.to_string(),
            status: RescueStepStatus::Skipped,
            bytes_reclaimed: 0,
            message: message.into(),
        }
    }

    pub fn failed(step: &str, message: impl Into<String>) -> Self {
        Self {
            step: step.to_string(),
            status: RescueStepStatus::Failed,
            bytes_reclaimed: 0,
            message: message.into(),
        }
    }
}

pub trait PlatformSystemMaintenance: Send + Sync {
    fn execute_maintenance_task(&self, task: MaintenanceTaskKind) -> Result<String, PlatformError>;
    fn execute_emergency_rescue(&self) -> Result<EmergencyRescueSummary, PlatformError>;
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RawBrowserProfile {
    pub browser_id: String,
    pub browser_name: String,
    pub profile_name: String,
    pub profile_path: PathBuf,
    pub is_running: bool,
}

pub trait PlatformPrivacy: Send + Sync {
    fn list_browser_profiles(&self) -> Result<Vec<RawBrowserProfile>, PlatformError>;
    fn clean_system_activity_traces(&self) -> Result<u64, PlatformError>;
    fn clean_clipboard(&self) -> Result<u64, PlatformError> {
        Ok(0)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HibernationInfo {
    pub enabled: bool,
    pub file_path: Option<PathBuf>,
    pub file_size_bytes: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PagingFileInfo {
    pub total_paging_bytes: u64,
    pub paging_files: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ExplorerSettings {
    pub show_file_extensions: bool,
    pub show_hidden_files: bool,
    pub launch_this_pc: bool,
    pub disable_bing_search: bool,
    pub classic_context_menu: bool,
    pub enable_end_task: bool,
    pub show_seconds: bool,
    pub disable_advertising_id: bool,
    pub disable_activity_upload: bool,
    pub enable_long_paths: bool,
    pub reduce_menu_delay: bool,
    pub disable_game_dvr: bool,
    pub disable_copilot: bool,
    pub disable_ntfs_last_access: bool,
}

pub trait PlatformOptimization: Send + Sync {
    fn get_hibernation_status(&self) -> Result<HibernationInfo, PlatformError>;
    fn set_hibernation_state(&self, enable: bool) -> Result<(), PlatformError>;
    fn get_storage_sense_status(&self) -> Result<bool, PlatformError>;
    fn set_storage_sense_state(&self, enable: bool) -> Result<(), PlatformError>;
    fn clean_delivery_optimization_cache(&self) -> Result<u64, PlatformError>;
    fn get_paging_file_info(&self) -> Result<PagingFileInfo, PlatformError>;
    fn get_explorer_settings(&self) -> Result<ExplorerSettings, PlatformError>;
    fn set_explorer_setting(&self, setting_key: &str, enable: bool) -> Result<(), PlatformError>;
    fn trim_process_working_set(&self) -> Result<(), PlatformError> {
        Ok(())
    }
}
