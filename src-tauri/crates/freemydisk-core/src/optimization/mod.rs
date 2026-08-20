use freemydisk_platform::{get_platform, PlatformOptimization};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OptimizationOverview {
    pub hibernation_enabled: bool,
    pub hibernation_size_bytes: Option<u64>,
    pub storage_sense_enabled: bool,
    pub paging_total_bytes: u64,
    pub paging_files: Vec<String>,
    pub delivery_cache_bytes: u64,
    pub explorer_settings: freemydisk_platform::ExplorerSettings,
}

pub struct OptimizationService {
    platform: Box<dyn PlatformOptimization>,
}

impl OptimizationService {
    pub fn new() -> Self {
        Self {
            platform: Box::new(get_platform()),
        }
    }

    pub fn with_platform(platform: Box<dyn PlatformOptimization>) -> Self {
        Self { platform }
    }

    pub fn get_overview(&self) -> Result<OptimizationOverview, String> {
        let hiber = self
            .platform
            .get_hibernation_status()
            .map_err(|e| e.to_string())?;

        let storage_sense = self.platform.get_storage_sense_status().unwrap_or(false);

        let paging = self.platform.get_paging_file_info().unwrap_or_else(|_| {
            freemydisk_platform::PagingFileInfo {
                total_paging_bytes: 0,
                paging_files: Vec::new(),
            }
        });

        let explorer = self.platform.get_explorer_settings().unwrap_or_default();

        // Calculate delivery cache bytes
        let mut do_bytes = 0u64;
        let windir = std::env::var("WINDIR").unwrap_or_else(|_| r"C:\Windows".to_string());
        let do_path =
            std::path::PathBuf::from(windir).join(r"SoftwareDistribution\DeliveryOptimization");
        if do_path.exists() {
            if let Ok(entries) = std::fs::read_dir(&do_path) {
                for entry in entries.flatten() {
                    if let Ok(meta) = entry.metadata() {
                        if meta.is_file() {
                            do_bytes += meta.len();
                        }
                    }
                }
            }
        }

        Ok(OptimizationOverview {
            hibernation_enabled: hiber.enabled,
            hibernation_size_bytes: hiber.file_size_bytes,
            storage_sense_enabled: storage_sense,
            paging_total_bytes: paging.total_paging_bytes,
            paging_files: paging.paging_files,
            delivery_cache_bytes: do_bytes,
            explorer_settings: explorer,
        })
    }

    pub fn set_hibernation(&self, enable: bool) -> Result<(), String> {
        self.platform
            .set_hibernation_state(enable)
            .map_err(|e| e.to_string())
    }

    pub fn set_storage_sense(&self, enable: bool) -> Result<(), String> {
        self.platform
            .set_storage_sense_state(enable)
            .map_err(|e| e.to_string())
    }

    pub fn clean_delivery_cache(&self) -> Result<u64, String> {
        self.platform
            .clean_delivery_optimization_cache()
            .map_err(|e| e.to_string())
    }

    pub fn set_explorer_setting(&self, setting_key: &str, enable: bool) -> Result<(), String> {
        self.platform
            .set_explorer_setting(setting_key, enable)
            .map_err(|e| e.to_string())
    }
}

impl Default for OptimizationService {
    fn default() -> Self {
        Self::new()
    }
}
