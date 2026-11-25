use super::filesystem::FilesystemLeftoverScanner;
use super::models::{LeftoverCandidate, LeftoverConfidence, LeftoverGroup};
use super::registry::RegistryLeftoverScanner;
use crate::applications::InstalledAppInfo;
use crate::cleanup::disposal::DisposalEngine;
use crate::cleanup::plan::CleanupPlanItem;
use crate::filesystem::journal::CrashRecoveryJournal;
use crate::shared::progress::CancellationToken;
use freemydisk_platform::PlatformFilesystem;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::Path;

/// Outcome of a leftover cleanup run.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct LeftoverCleanSummary {
    pub freed_bytes: u64,
    pub removed_folders: usize,
    pub removed_registry_keys: usize,
    /// Paths or keys that could not be removed.
    pub failed: Vec<String>,
}

pub struct LeftoverScanner;

impl LeftoverScanner {
    /// Comprehensive system scan for application remnants across filesystem and registry
    pub fn scan_deep(installed_apps: &[InstalledAppInfo]) -> Vec<LeftoverGroup> {
        let installed_names: HashSet<String> = installed_apps
            .iter()
            .map(|a| a.name.to_lowercase())
            .collect();

        let fs_candidates = FilesystemLeftoverScanner::scan_all(&installed_names);

        // Group filesystem candidates by application/directory name
        let mut groups_map: HashMap<String, Vec<LeftoverCandidate>> = HashMap::new();
        for candidate in fs_candidates {
            let app_key = Path::new(&candidate.path_or_key)
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| "Unknown App".to_string());
            groups_map.entry(app_key).or_default().push(candidate);
        }

        let mut groups = Vec::new();
        for (app_name, items) in groups_map {
            let total_size_bytes: u64 = items.iter().map(|i| i.size_bytes).sum();
            let overall_confidence = items
                .iter()
                .map(|i| i.confidence)
                .max()
                .unwrap_or(LeftoverConfidence::Low);

            groups.push(LeftoverGroup {
                id: format!("group:{}", app_name),
                app_name: app_name.clone(),
                publisher: None,
                items,
                total_size_bytes,
                overall_confidence,
            });
        }

        // Sort descending by total size
        groups.sort_by_key(|g| std::cmp::Reverse(g.total_size_bytes));
        groups
    }

    /// Targeted scan for a specific application that was uninstalled
    pub fn scan_for_app(
        app_name: &str,
        publisher: Option<&str>,
        install_location: Option<&str>,
    ) -> LeftoverGroup {
        let mut items =
            FilesystemLeftoverScanner::scan_for_app(app_name, publisher, install_location);
        let reg_items = RegistryLeftoverScanner::scan_for_app(app_name, publisher);
        items.extend(reg_items);

        let total_size_bytes: u64 = items.iter().map(|i| i.size_bytes).sum();
        let overall_confidence = items
            .iter()
            .map(|i| i.confidence)
            .max()
            .unwrap_or(LeftoverConfidence::High);

        LeftoverGroup {
            id: format!("group:{}", app_name),
            app_name: app_name.to_string(),
            publisher: publisher.map(|p| p.to_string()),
            items,
            total_size_bytes,
            overall_confidence,
        }
    }

    /// Removes leftover folders and registry keys.
    ///
    /// Folders go through the disposal engine: Recycle Bin only, protected-path checks,
    /// journal and cross-process lock. Registry keys must match the leftover key policy.
    /// Callers must pass only items returned by a leftover scan.
    pub fn clean_items(
        paths_or_keys: &[String],
        include_registry: bool,
        platform: &dyn PlatformFilesystem,
        journal: &CrashRecoveryJournal,
        lock_dir: &Path,
    ) -> Result<LeftoverCleanSummary, String> {
        let mut summary = LeftoverCleanSummary::default();
        let mut plan_items = Vec::new();

        for item in paths_or_keys {
            let trimmed = item.trim();
            let upper = trimmed.to_ascii_uppercase();
            if upper.starts_with(r"HKCU\") || upper.starts_with(r"HKLM\") {
                if !include_registry {
                    continue;
                }
                match RegistryLeftoverScanner::clean_registry_key(trimmed) {
                    Ok(()) => summary.removed_registry_keys += 1,
                    Err(e) => {
                        log::warn!("Failed to delete leftover registry key {}: {}", trimmed, e);
                        summary.failed.push(trimmed.to_string());
                    }
                }
                continue;
            }

            let path = Path::new(trimmed);
            if !path.exists() {
                continue;
            }
            let (size, _) = FilesystemLeftoverScanner::calculate_dir_metrics(path);
            plan_items.push(CleanupPlanItem {
                original_path: path.to_path_buf(),
                canonical_path: crate::shared::paths::normalize_path(path),
                size_bytes: size,
                is_dir: path.is_dir(),
                matched_rules: vec!["application_leftover".to_string()],
                default_action: "trash".to_string(),
                verified_rebuildable: false,
                protect_subpaths: Vec::new(),
                risk: "caution".to_string(),
            });
        }

        if !plan_items.is_empty() {
            let cancel = CancellationToken::new();
            let disposal = DisposalEngine::execute_plan(
                &plan_items,
                platform,
                journal,
                lock_dir,
                true,
                &cancel,
            )
            .map_err(|e| e.to_string())?;
            summary.freed_bytes = disposal.total_freed_bytes;
            summary.removed_folders = disposal.successful_items;
            summary.failed.extend(
                disposal
                    .results
                    .iter()
                    .filter(|r| !r.success)
                    .map(|r| r.path.to_string_lossy().to_string()),
            );
        }

        Ok(summary)
    }
}
