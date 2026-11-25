use freemydisk_core::optimization::OptimizationService;
use freemydisk_platform::{
    ExplorerSettings, HibernationInfo, PagingFileInfo, PlatformError, PlatformOptimization,
};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

struct MockOptimizationPlatform {
    hibernation_enabled: Arc<Mutex<bool>>,
    storage_sense_enabled: Arc<Mutex<bool>>,
    explorer_settings: Arc<Mutex<ExplorerSettings>>,
}

impl PlatformOptimization for MockOptimizationPlatform {
    fn get_hibernation_status(&self) -> Result<HibernationInfo, PlatformError> {
        let enabled = *self.hibernation_enabled.lock().unwrap();
        Ok(HibernationInfo {
            enabled,
            file_path: if enabled {
                Some(PathBuf::from(r"C:\hiberfil.sys"))
            } else {
                None
            },
            file_size_bytes: if enabled {
                Some(12 * 1024 * 1024 * 1024)
            } else {
                None
            },
        })
    }

    fn set_hibernation_state(&self, enable: bool) -> Result<(), PlatformError> {
        *self.hibernation_enabled.lock().unwrap() = enable;
        Ok(())
    }

    fn get_storage_sense_status(&self) -> Result<bool, PlatformError> {
        Ok(*self.storage_sense_enabled.lock().unwrap())
    }

    fn set_storage_sense_state(&self, enable: bool) -> Result<(), PlatformError> {
        *self.storage_sense_enabled.lock().unwrap() = enable;
        Ok(())
    }

    fn clean_delivery_optimization_cache(&self) -> Result<u64, PlatformError> {
        Ok(500 * 1024 * 1024)
    }

    fn get_paging_file_info(&self) -> Result<PagingFileInfo, PlatformError> {
        Ok(PagingFileInfo {
            total_paging_bytes: 8 * 1024 * 1024 * 1024,
            paging_files: vec![r"C:\pagefile.sys".to_string()],
        })
    }

    fn get_explorer_settings(&self) -> Result<ExplorerSettings, PlatformError> {
        Ok(self.explorer_settings.lock().unwrap().clone())
    }

    fn set_explorer_setting(&self, setting_key: &str, enable: bool) -> Result<(), PlatformError> {
        let mut settings = self.explorer_settings.lock().unwrap();
        match setting_key {
            "show_file_extensions" | "showFileExtensions" => settings.show_file_extensions = enable,
            "show_hidden_files" | "showHiddenFiles" => settings.show_hidden_files = enable,
            "launch_this_pc" | "launchThisPc" => settings.launch_this_pc = enable,
            "disable_bing_search" | "disableBingSearch" => settings.disable_bing_search = enable,
            _ => {
                return Err(PlatformError::OperationFailed(format!(
                    "Unknown key: {}",
                    setting_key
                )))
            }
        }
        Ok(())
    }
}

#[test]
fn test_optimization_overview_and_toggles() {
    let hiber = Arc::new(Mutex::new(true));
    let sense = Arc::new(Mutex::new(false));
    let explorer = Arc::new(Mutex::new(ExplorerSettings {
        show_file_extensions: false,
        show_hidden_files: false,
        launch_this_pc: false,
        disable_bing_search: false,
        ..Default::default()
    }));

    let platform = Box::new(MockOptimizationPlatform {
        hibernation_enabled: Arc::clone(&hiber),
        storage_sense_enabled: Arc::clone(&sense),
        explorer_settings: Arc::clone(&explorer),
    });

    let service = OptimizationService::with_platform(platform);
    let overview = service.get_overview().expect("Failed to get overview");

    assert!(overview.hibernation_enabled);
    assert_eq!(
        overview.hibernation_size_bytes,
        Some(12 * 1024 * 1024 * 1024)
    );
    assert!(!overview.storage_sense_enabled);
    assert_eq!(overview.paging_total_bytes, 8 * 1024 * 1024 * 1024);

    // Toggle hibernation off
    assert!(service.set_hibernation(false).is_ok());
    let updated = service.get_overview().unwrap();
    assert!(!updated.hibernation_enabled);
    assert_eq!(updated.hibernation_size_bytes, None);

    // Toggle storage sense on
    assert!(service.set_storage_sense(true).is_ok());
    let updated_sense = service.get_overview().unwrap();
    assert!(updated_sense.storage_sense_enabled);

    // Clean delivery cache
    let cleaned = service.clean_delivery_cache().unwrap();
    assert_eq!(cleaned, 500 * 1024 * 1024);

    // Explorer settings test
    assert!(!overview.explorer_settings.show_file_extensions);
    assert!(service
        .set_explorer_setting("show_file_extensions", true)
        .is_ok());
    let updated_explorer = service.get_overview().unwrap();
    assert!(updated_explorer.explorer_settings.show_file_extensions);
}
