pub mod catalog;
pub mod leftovers;
pub mod process_control;
pub mod uninstall;

use freemydisk_platform::{get_platform, PlatformApplications, PlatformFilesystem, RawUwpApp};
use serde::{Deserialize, Serialize};

pub use catalog::ApplicationCatalog;
pub use leftovers::models::{
    ApplicationLeftover, LeftoverCandidate, LeftoverConfidence, LeftoverGroup, LeftoverKind,
};
pub use leftovers::scanner::LeftoverScanner;
pub use process_control::ProcessController;
pub use uninstall::{UninstallOrchestrator, UninstallResult};

pub type UwpAppInfo = RawUwpApp;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstalledAppInfo {
    pub id: String,
    pub name: String,
    pub publisher: Option<String>,
    pub display_version: Option<String>,
    pub install_location: Option<String>,
    pub uninstall_string: Option<String>,
    pub estimated_size_bytes: Option<u64>,
    pub install_date: Option<String>,
    pub is_running: bool,
    pub display_icon: Option<String>,
    pub icon_data: Option<String>,
}

pub struct ApplicationService {
    platform: Box<dyn PlatformApplications>,
    _fs_platform: Box<dyn PlatformFilesystem>,
}

impl ApplicationService {
    pub fn new() -> Self {
        Self {
            platform: Box::new(get_platform()),
            _fs_platform: Box::new(get_platform()),
        }
    }

    pub fn with_platform(
        platform: Box<dyn PlatformApplications>,
        _fs_platform: Box<dyn PlatformFilesystem>,
    ) -> Self {
        Self {
            platform,
            _fs_platform,
        }
    }

    /// Lists installed applications with running status and size metrics
    pub fn list_applications(&self) -> Result<Vec<InstalledAppInfo>, String> {
        ApplicationCatalog::list_applications()
    }

    /// Deep scanner for all leftover application groups
    pub fn scan_deep_leftovers(&self) -> Result<Vec<LeftoverGroup>, String> {
        let apps = self.list_applications().unwrap_or_default();
        Ok(LeftoverScanner::scan_deep(&apps))
    }

    /// Backward-compatible flat scan for application leftovers
    pub fn scan_leftovers(&self) -> Result<Vec<ApplicationLeftover>, String> {
        let groups = self.scan_deep_leftovers()?;
        let mut flat = Vec::new();

        for group in groups {
            for item in group.items {
                flat.push(ApplicationLeftover {
                    id: item.id,
                    app_name: group.app_name.clone(),
                    path: item.path_or_key,
                    size_bytes: item.size_bytes,
                    item_count: item.item_count,
                    category: item.description,
                    confidence: item.confidence.to_string(),
                });
            }
        }

        flat.sort_by_key(|l| std::cmp::Reverse(l.size_bytes));
        Ok(flat)
    }

    /// Cleans leftover items across filesystem and registry
    pub fn clean_leftovers(&self, paths: &[String]) -> Result<u64, String> {
        LeftoverScanner::clean_items(paths, true)
    }

    /// Safely terminates running processes matching an app
    pub fn terminate_app(&self, app_name: &str) -> Result<usize, String> {
        ProcessController::terminate_app_processes(app_name)
    }

    /// Orchestrates uninstallation and scans for leftovers
    pub fn uninstall_and_scan(&self, app_id: &str) -> Result<UninstallResult, String> {
        let apps = self.list_applications()?;
        let target_app = apps
            .into_iter()
            .find(|a| a.id == app_id || a.name == app_id)
            .ok_or_else(|| format!("Application with ID '{}' not found", app_id))?;

        UninstallOrchestrator::uninstall_and_scan(&target_app)
    }

    /// Orchestrates silent uninstallation with engine-specific switches and scans for leftovers
    pub fn uninstall_and_scan_silent(&self, app_id: &str) -> Result<UninstallResult, String> {
        let apps = self.list_applications()?;
        let target_app = apps
            .into_iter()
            .find(|a| a.id == app_id || a.name == app_id)
            .ok_or_else(|| format!("Application with ID '{}' not found", app_id))?;

        UninstallOrchestrator::uninstall_and_scan_silent(&target_app)
    }

    pub fn launch_uninstaller(&self, uninstall_string: &str) -> Result<(), String> {
        self.platform
            .launch_uninstaller(uninstall_string)
            .map_err(|e| e.to_string())
    }

    pub fn launch_silent_uninstaller(
        &self,
        uninstall_string: &str,
        install_dir: Option<&str>,
    ) -> Result<(), String> {
        self.platform
            .launch_silent_uninstaller(uninstall_string, install_dir)
            .map_err(|e| e.to_string())
    }

    pub fn get_locking_processes(
        &self,
        path: &std::path::Path,
    ) -> Result<Vec<freemydisk_platform::RawRunningProcess>, String> {
        self.platform
            .get_locking_processes(path)
            .map_err(|e| e.to_string())
    }

    pub fn list_uwp_applications(&self) -> Result<Vec<UwpAppInfo>, String> {
        self.platform.list_uwp_apps().map_err(|e| e.to_string())
    }

    pub fn uninstall_uwp_application(&self, package_full_name: &str) -> Result<(), String> {
        self.platform
            .uninstall_uwp_app(package_full_name)
            .map_err(|e| e.to_string())
    }
}

impl Default for ApplicationService {
    fn default() -> Self {
        Self::new()
    }
}
