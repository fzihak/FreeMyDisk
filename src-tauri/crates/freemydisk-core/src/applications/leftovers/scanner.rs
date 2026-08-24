use super::filesystem::FilesystemLeftoverScanner;
use super::models::{LeftoverCandidate, LeftoverConfidence, LeftoverGroup};
use super::registry::RegistryLeftoverScanner;
use crate::applications::InstalledAppInfo;
use freemydisk_platform::{get_platform, PlatformFilesystem};
use std::collections::{HashMap, HashSet};
use std::path::Path;

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

    /// Safely cleans leftover candidates using Trash-First invariant for files and registry deletion
    pub fn clean_items(paths_or_keys: &[String], include_registry: bool) -> Result<u64, String> {
        let mut total_reclaimed = 0u64;
        let fs_platform = get_platform();

        for item in paths_or_keys {
            let trimmed = item.trim();
            if trimmed.starts_with("HKCU\\") || trimmed.starts_with("HKLM\\") {
                if include_registry {
                    if let Err(e) = RegistryLeftoverScanner::clean_registry_key(trimmed) {
                        log::warn!("Failed to delete leftover registry key {}: {}", trimmed, e);
                    } else {
                        total_reclaimed += 1024;
                    }
                }
            } else {
                let path = Path::new(trimmed);
                if !path.exists() {
                    continue;
                }

                let (size, _) = FilesystemLeftoverScanner::calculate_dir_metrics(path);

                // Trash-First invariant: try OS recycle bin first
                if fs_platform.trash_path(path).is_ok() {
                    total_reclaimed += size;
                } else {
                    let cancel = crate::shared::progress::CancellationToken::new();
                    let (freed, _) =
                        crate::cleanup::disposal::execute_tolerant_permanent_delete(path, &cancel);
                    total_reclaimed += if freed > 0 { freed } else { size };
                }
            }
        }

        Ok(total_reclaimed)
    }
}
