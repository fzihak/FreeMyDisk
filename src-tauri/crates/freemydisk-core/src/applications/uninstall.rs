use super::leftovers::models::LeftoverGroup;
use super::leftovers::scanner::LeftoverScanner;
use super::process_control::ProcessController;
use super::InstalledAppInfo;
use freemydisk_platform::{get_platform, PlatformApplications};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UninstallResult {
    pub app_id: String,
    pub app_name: String,
    pub success: bool,
    pub message: String,
    pub leftovers: Option<LeftoverGroup>,
}

pub struct UninstallOrchestrator;

impl UninstallOrchestrator {
    /// Full uninstallation pipeline:
    /// 1. Gracefully terminates any running processes belonging to the application
    /// 2. Launches the application's native uninstaller
    /// 3. Scans for residual files, directories, and registry keys for the application
    /// 4. Returns the result and discovered leftovers for one-click cleanup
    pub fn uninstall_and_scan(app: &InstalledAppInfo) -> Result<UninstallResult, String> {
        // 1. Terminate any active running processes
        if app.is_running {
            let _ = ProcessController::terminate_app_processes(&app.name);
        }

        // 2. Launch native uninstaller
        if let Some(ref uninst_cmd) = app.uninstall_string {
            get_platform()
                .launch_uninstaller(uninst_cmd)
                .map_err(|e| e.to_string())?;
        } else {
            return Err(format!(
                "No registered uninstall command found for application '{}'",
                app.name
            ));
        }

        // 3. Scan for leftovers
        let leftovers = LeftoverScanner::scan_for_app(
            &app.name,
            app.publisher.as_deref(),
            app.install_location.as_deref(),
        );

        let has_leftovers = !leftovers.items.is_empty();

        Ok(UninstallResult {
            app_id: app.id.clone(),
            app_name: app.name.clone(),
            success: true,
            message: format!("Uninstaller launched for '{}'", app.name),
            leftovers: if has_leftovers { Some(leftovers) } else { None },
        })
    }

    /// Full silent uninstallation pipeline:
    /// Uses engine-tailored silent flags (MSI, Inno, NSIS, InstallShield, Squirrel)
    pub fn uninstall_and_scan_silent(app: &InstalledAppInfo) -> Result<UninstallResult, String> {
        // 1. Terminate any active running processes
        if app.is_running {
            let _ = ProcessController::terminate_app_processes(&app.name);
        }

        // 2. Launch silent uninstaller
        if let Some(ref uninst_cmd) = app.uninstall_string {
            get_platform()
                .launch_silent_uninstaller(uninst_cmd, app.install_location.as_deref())
                .map_err(|e| e.to_string())?;
        } else {
            return Err(format!(
                "No registered uninstall command found for application '{}'",
                app.name
            ));
        }

        // 3. Scan for leftovers
        let leftovers = LeftoverScanner::scan_for_app(
            &app.name,
            app.publisher.as_deref(),
            app.install_location.as_deref(),
        );

        let has_leftovers = !leftovers.items.is_empty();

        Ok(UninstallResult {
            app_id: app.id.clone(),
            app_name: app.name.clone(),
            success: true,
            message: format!("Silent uninstaller launched for '{}'", app.name),
            leftovers: if has_leftovers { Some(leftovers) } else { None },
        })
    }
}
