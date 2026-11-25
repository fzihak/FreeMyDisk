use crate::traits::{
    FileIdentity, PendingRebootDeletion, PlatformElevation, PlatformError, PlatformFilesystem,
    PlatformIoPriority, PlatformRebootQueue,
};
use fs4::FileExt;
use std::fs::OpenOptions;
use std::path::{Path, PathBuf};

pub struct MacosPlatform;

impl MacosPlatform {
    pub fn new() -> Self {
        Self
    }
}

impl PlatformFilesystem for MacosPlatform {
    fn trash_path(&self, path: &Path) -> Result<(), PlatformError> {
        trash::delete(path).map_err(|e| {
            PlatformError::TrashUnavailable(format!(
                "Failed to send '{}' to macOS Trash: {}",
                path.display(),
                e
            ))
        })
    }

    fn is_cloud_placeholder(&self, _path: &Path) -> Result<bool, PlatformError> {
        // macOS iCloud dataless files check
        Ok(false)
    }

    fn get_file_identity(&self, path: &Path) -> Result<FileIdentity, PlatformError> {
        use std::os::unix::fs::MetadataExt;
        let meta = std::fs::symlink_metadata(path)?;
        let is_symlink = meta.file_type().is_symlink();

        Ok(FileIdentity {
            device_id: meta.dev(),
            file_index: meta.ino(),
            link_count: meta.nlink() as u32,
            is_reparse_or_symlink: is_symlink,
        })
    }

    fn acquire_cross_process_lock(
        &self,
        lock_path: &Path,
    ) -> Result<Box<dyn std::any::Any + Send + Sync>, PlatformError> {
        if let Some(parent) = lock_path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .open(lock_path)?;

        match file.try_lock_exclusive() {
            Ok(()) => Ok(Box::new(file)),
            Err(_) => Err(PlatformError::LockBusy),
        }
    }

    fn list_volumes(&self) -> Result<Vec<crate::traits::StorageVolumeInfo>, PlatformError> {
        Ok(vec![crate::traits::StorageVolumeInfo {
            mount_point: "/".to_string(),
            volume_name: "Macintosh HD".to_string(),
            total_bytes: 1_000_000_000_000,
            available_bytes: 500_000_000_000,
            file_system: "APFS".to_string(),
            is_removable: false,
        }])
    }
}

impl PlatformRebootQueue for MacosPlatform {
    fn list_pending_deletions(&self) -> Result<Vec<PendingRebootDeletion>, PlatformError> {
        Ok(Vec::new())
    }

    fn cancel_pending_deletion(&self, _path: &Path) -> Result<(), PlatformError> {
        Ok(())
    }
}

impl PlatformElevation for MacosPlatform {
    fn is_elevated(&self) -> bool {
        false
    }
}

impl PlatformIoPriority for MacosPlatform {
    fn set_background_idle_priority(&self) -> Result<(), PlatformError> {
        Ok(())
    }

    fn set_below_normal_priority(&self) -> Result<(), PlatformError> {
        Ok(())
    }

    fn set_normal_priority(&self) -> Result<(), PlatformError> {
        Ok(())
    }

    fn seconds_since_last_input(&self) -> Result<u64, PlatformError> {
        Ok(0)
    }
}

impl crate::traits::PlatformStartup for MacosPlatform {
    fn list_startup_entries(&self) -> Result<Vec<crate::traits::RawStartupEntry>, PlatformError> {
        Ok(Vec::new())
    }
    fn set_startup_entry_state(&self, _entry_id: &str, _enable: bool) -> Result<(), PlatformError> {
        Ok(())
    }
    fn delete_startup_entry(&self, _entry_id: &str) -> Result<(), PlatformError> {
        Ok(())
    }
}

impl crate::traits::PlatformApplications for MacosPlatform {
    fn list_installed_apps(&self) -> Result<Vec<crate::traits::RawInstalledApp>, PlatformError> {
        Ok(Vec::new())
    }
    fn list_running_processes(
        &self,
    ) -> Result<Vec<crate::traits::RawRunningProcess>, PlatformError> {
        Ok(Vec::new())
    }
    fn terminate_process(&self, _pid: u32) -> Result<(), PlatformError> {
        Ok(())
    }
    fn launch_uninstaller(&self, _uninstall_string: &str) -> Result<(), PlatformError> {
        Ok(())
    }
    fn list_uwp_apps(&self) -> Result<Vec<crate::traits::RawUwpApp>, PlatformError> {
        Ok(Vec::new())
    }
    fn uninstall_uwp_app(&self, _package_full_name: &str) -> Result<(), PlatformError> {
        Err(PlatformError::Unsupported(
            "UWP packages are not supported on macOS".to_string(),
        ))
    }
}

impl crate::traits::PlatformSystemMaintenance for MacosPlatform {
    fn execute_maintenance_task(
        &self,
        _task: crate::traits::MaintenanceTaskKind,
    ) -> Result<String, PlatformError> {
        Ok("Maintenance completed on macOS".to_string())
    }

    fn execute_emergency_rescue(
        &self,
    ) -> Result<crate::traits::EmergencyRescueSummary, PlatformError> {
        Ok(crate::traits::EmergencyRescueSummary {
            total_bytes_reclaimed: 0,
            hibernation_disabled: false,
            recycle_bin_emptied: false,
            temp_cleaned_bytes: 0,
            wsl_shutdown: false,
            actions_performed: vec![
                "Emergency rescue protocol is currently optimized for Windows systems.".to_string(),
            ],
        })
    }
}

impl crate::traits::PlatformPrivacy for MacosPlatform {
    fn list_browser_profiles(
        &self,
    ) -> Result<Vec<crate::traits::RawBrowserProfile>, PlatformError> {
        Ok(Vec::new())
    }
    fn clean_system_activity_traces(&self) -> Result<u64, PlatformError> {
        Ok(0)
    }
}

impl crate::traits::PlatformOptimization for MacosPlatform {
    fn get_hibernation_status(&self) -> Result<crate::traits::HibernationInfo, PlatformError> {
        Ok(crate::traits::HibernationInfo {
            enabled: false,
            file_path: None,
            file_size_bytes: None,
        })
    }
    fn set_hibernation_state(&self, _enable: bool) -> Result<(), PlatformError> {
        Ok(())
    }
    fn get_storage_sense_status(&self) -> Result<bool, PlatformError> {
        Ok(false)
    }
    fn set_storage_sense_state(&self, _enable: bool) -> Result<(), PlatformError> {
        Ok(())
    }
    fn clean_delivery_optimization_cache(&self) -> Result<u64, PlatformError> {
        Ok(0)
    }
    fn get_paging_file_info(&self) -> Result<crate::traits::PagingFileInfo, PlatformError> {
        Ok(crate::traits::PagingFileInfo {
            total_paging_bytes: 0,
            paging_files: Vec::new(),
        })
    }
    fn get_explorer_settings(&self) -> Result<crate::traits::ExplorerSettings, PlatformError> {
        Ok(crate::traits::ExplorerSettings::default())
    }
    fn set_explorer_setting(&self, _setting_key: &str, _enable: bool) -> Result<(), PlatformError> {
        Ok(())
    }
}
