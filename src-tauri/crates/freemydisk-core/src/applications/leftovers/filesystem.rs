use super::confidence::ConfidenceScorer;
use super::models::{LeftoverCandidate, LeftoverConfidence, LeftoverKind};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

pub struct FilesystemLeftoverScanner;

impl FilesystemLeftoverScanner {
    /// Whitelist of system and core vendor directory names never to be considered as leftovers
    fn get_system_whitelist() -> HashSet<&'static str> {
        [
            "microsoft",
            "windows",
            "common files",
            "temp",
            "programs",
            "packages",
            "system",
            "system32",
            "syswow64",
            "google",
            "freemydisk",
            "nvidia",
            "intel",
            "amd",
            "git",
            "yarn",
            "npm",
            "pnpm",
            "cargo",
            "rust",
            "connecteddevicesplatform",
            "publishers",
            "virtualstore",
            "crashdumps",
            "history",
            "appdata",
            "temporary internet files",
            "application data",
            "usertiles",
            "cryptography",
            "identityhx",
            "comms",
            "assembly",
            "windowsapps",
        ]
        .into_iter()
        .collect()
    }

    /// Gets standard search roots for application data remnants
    fn get_search_roots() -> Vec<(PathBuf, &'static str)> {
        let mut roots = Vec::new();
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            roots.push((PathBuf::from(local), "AppData Local"));
        }
        if let Ok(roaming) = std::env::var("APPDATA") {
            roots.push((PathBuf::from(roaming), "AppData Roaming"));
        }
        if let Ok(progdata) = std::env::var("PROGRAMDATA") {
            roots.push((PathBuf::from(progdata), "ProgramData"));
        }
        roots
    }

    /// Recursively calculates directory size and item count without traversing symlink loops
    pub fn calculate_dir_metrics(path: &Path) -> (u64, u64) {
        let mut size = 0u64;
        let mut count = 0u64;

        for entry in WalkDir::new(path)
            .min_depth(1)
            .follow_links(false)
            .into_iter()
            .filter_map(|e| e.ok())
        {
            count += 1;
            if let Ok(meta) = entry.metadata() {
                if meta.is_file() {
                    size += meta.len();
                }
            }
        }

        (size, count)
    }

    /// Scans standard directories for orphaned application data not matching any active installed app
    pub fn scan_all(installed_names: &HashSet<String>) -> Vec<LeftoverCandidate> {
        let whitelist = Self::get_system_whitelist();
        let roots = Self::get_search_roots();
        let mut results = Vec::new();

        for (root, category_desc) in roots {
            if !root.exists() {
                continue;
            }

            let entries = match std::fs::read_dir(&root) {
                Ok(e) => e,
                Err(_) => continue,
            };

            for entry in entries.flatten() {
                let path = entry.path();
                if !path.is_dir() {
                    continue;
                }

                let folder_name = entry.file_name().to_string_lossy().to_string();
                let lower_folder = folder_name.to_lowercase();

                if whitelist.contains(lower_folder.as_str()) {
                    continue;
                }

                // Match against installed apps
                let norm_folder = lower_folder.replace(['-', '_', ' ', '.'], "");
                let matches_installed = installed_names.iter().any(|app| {
                    let norm_app = app.replace(['-', '_', ' ', '.'], "");
                    if norm_folder.is_empty() || norm_app.is_empty() {
                        return false;
                    }
                    if norm_folder == norm_app {
                        return true;
                    }
                    if norm_folder.len() >= 4 && norm_app.contains(&norm_folder) {
                        return true;
                    }
                    if norm_app.len() >= 4 && norm_folder.contains(&norm_app) {
                        return true;
                    }
                    false
                });

                if !matches_installed {
                    let (size_bytes, item_count) = Self::calculate_dir_metrics(&path);
                    // Filter out trivial 0-byte directories; keep directories >= 512 KB
                    if size_bytes >= 512 * 1024 {
                        let confidence =
                            ConfidenceScorer::score_filesystem(&folder_name, None, None, &path);

                        results.push(LeftoverCandidate {
                            id: format!("fs:{}", path.to_string_lossy()),
                            path_or_key: path.to_string_lossy().to_string(),
                            kind: LeftoverKind::Filesystem,
                            size_bytes,
                            item_count,
                            confidence,
                            description: format!("{} Remnant ({})", category_desc, folder_name),
                        });
                    }
                }
            }
        }

        // Sort descending by size
        results.sort_by_key(|r| std::cmp::Reverse(r.size_bytes));
        results
    }

    /// Targeted scan for residual files of a specific application that was recently uninstalled
    pub fn scan_for_app(
        app_name: &str,
        publisher: Option<&str>,
        install_location: Option<&str>,
    ) -> Vec<LeftoverCandidate> {
        let roots = Self::get_search_roots();
        let mut results = Vec::new();
        let app_lower = app_name.to_lowercase();
        let app_clean = app_lower.replace(['-', '_', ' ', '.'], "");

        // 1. Check AppData and ProgramData roots
        for (root, desc) in &roots {
            if !root.exists() {
                continue;
            }

            // Direct app folder
            let direct_folder = root.join(app_name);
            if direct_folder.exists() && direct_folder.is_dir() {
                let (size, count) = Self::calculate_dir_metrics(&direct_folder);
                results.push(LeftoverCandidate {
                    id: format!("fs:{}", direct_folder.to_string_lossy()),
                    path_or_key: direct_folder.to_string_lossy().to_string(),
                    kind: LeftoverKind::Filesystem,
                    size_bytes: size,
                    item_count: count,
                    confidence: LeftoverConfidence::High,
                    description: format!("{} residual data", desc),
                });
            }

            // Publisher subfolder if applicable (e.g. %LOCALAPPDATA%\Publisher\App)
            if let Some(pub_name) = publisher {
                let pub_folder = root.join(pub_name).join(app_name);
                if pub_folder.exists() && pub_folder.is_dir() {
                    let (size, count) = Self::calculate_dir_metrics(&pub_folder);
                    results.push(LeftoverCandidate {
                        id: format!("fs:{}", pub_folder.to_string_lossy()),
                        path_or_key: pub_folder.to_string_lossy().to_string(),
                        kind: LeftoverKind::Filesystem,
                        size_bytes: size,
                        item_count: count,
                        confidence: LeftoverConfidence::High,
                        description: format!("{} publisher app data", desc),
                    });
                }
            }

            // Scan child entries for partial matches
            if let Ok(entries) = std::fs::read_dir(root) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if !path.is_dir() {
                        continue;
                    }
                    let folder_name = entry.file_name().to_string_lossy().to_string();
                    let folder_clean = folder_name.to_lowercase().replace(['-', '_', ' ', '.'], "");
                    if (folder_clean == app_clean
                        || (app_clean.len() >= 4 && folder_clean.contains(&app_clean)))
                        && results
                            .iter()
                            .all(|r| r.path_or_key != path.to_string_lossy())
                    {
                        let (size, count) = Self::calculate_dir_metrics(&path);
                        results.push(LeftoverCandidate {
                            id: format!("fs:{}", path.to_string_lossy()),
                            path_or_key: path.to_string_lossy().to_string(),
                            kind: LeftoverKind::Filesystem,
                            size_bytes: size,
                            item_count: count,
                            confidence: LeftoverConfidence::High,
                            description: format!("{} remnant directory", desc),
                        });
                    }
                }
            }
        }

        // 2. Check original install location if provided
        if let Some(loc) = install_location {
            let loc_path = PathBuf::from(loc);
            if loc_path.exists() && loc_path.is_dir() {
                let (size, count) = Self::calculate_dir_metrics(&loc_path);
                results.push(LeftoverCandidate {
                    id: format!("fs:{}", loc_path.to_string_lossy()),
                    path_or_key: loc_path.to_string_lossy().to_string(),
                    kind: LeftoverKind::Filesystem,
                    size_bytes: size,
                    item_count: count,
                    confidence: LeftoverConfidence::High,
                    description: "Residual install directory".to_string(),
                });
            }
        }

        // 3. Check %USERPROFILE%\.{app_name}
        if let Ok(home) = std::env::var("USERPROFILE") {
            let dot_folder = PathBuf::from(home).join(format!(".{}", app_name));
            if dot_folder.exists() && dot_folder.is_dir() {
                let (size, count) = Self::calculate_dir_metrics(&dot_folder);
                results.push(LeftoverCandidate {
                    id: format!("fs:{}", dot_folder.to_string_lossy()),
                    path_or_key: dot_folder.to_string_lossy().to_string(),
                    kind: LeftoverKind::Filesystem,
                    size_bytes: size,
                    item_count: count,
                    confidence: LeftoverConfidence::Medium,
                    description: "User profile dot-configuration directory".to_string(),
                });
            }
        }

        results
    }
}
