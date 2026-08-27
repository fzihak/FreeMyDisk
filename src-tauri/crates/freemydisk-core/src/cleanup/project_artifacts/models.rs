use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectArtifact {
    pub path: PathBuf,
    pub relative_path: String,
    pub category: String,
    pub size_bytes: u64,
    pub item_count: usize,
    pub risk: String,
    pub verified_rebuildable: bool,
    pub rebuild_command: Option<String>,
    pub staleness_days: u32,
    pub selected: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectMatch {
    pub project_root: PathBuf,
    pub project_type: String,
    pub project_name: String,
    pub artifacts: Vec<ProjectArtifact>,
    pub total_reclaimable_bytes: u64,
    pub last_modified_days_ago: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectArtifactScanResult {
    pub total_projects: usize,
    pub total_artifacts: usize,
    pub total_reclaimable_bytes: u64,
    pub projects: Vec<ProjectMatch>,
    pub scan_duration_ms: u64,
}
