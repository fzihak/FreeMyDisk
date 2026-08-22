use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WslDistribution {
    pub name: String,
    pub vhdx_path: PathBuf,
    pub vhdx_actual_bytes: u64,
    pub vhdx_virtual_bytes: u64,
    pub reclaimable_estimate: u64,
    pub state: String, // "Running" | "Stopped"
    pub is_default: bool,
    pub version: u32, // 1 or 2
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DockerSpaceCategory {
    pub category: String, // "Images", "Containers", "Local Volumes", "Build Cache"
    pub total_count: usize,
    pub active_count: usize,
    pub size_bytes: u64,
    pub reclaimable_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DockerInfo {
    pub is_installed: bool,
    pub is_running: bool,
    pub server_version: Option<String>,
    pub storage_driver: Option<String>,
    pub data_root: Option<String>,
    pub total_space_bytes: u64,
    pub total_reclaimable_bytes: u64,
    pub categories: Vec<DockerSpaceCategory>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HyperVDisk {
    pub vm_name: String,
    pub disk_path: PathBuf,
    pub size_bytes: u64,
    pub format: String, // "VHDX" | "VDI" | "VMDK"
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VirtualizationOverview {
    pub wsl_installed: bool,
    pub wsl_distributions: Vec<WslDistribution>,
    pub total_wsl_bytes: u64,
    pub total_wsl_reclaimable: u64,
    pub docker: DockerInfo,
    pub hyperv_disks: Vec<HyperVDisk>,
    pub total_vm_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompactionResult {
    pub target_name: String,
    pub path: PathBuf,
    pub before_bytes: u64,
    pub after_bytes: u64,
    pub freed_bytes: u64,
    pub success: bool,
    pub message: String,
}
