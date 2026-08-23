use super::InstalledAppInfo;
use freemydisk_platform::{get_platform, PlatformApplications};
use std::collections::HashSet;
use std::path::Path;
use walkdir::WalkDir;

pub struct ApplicationCatalog;

impl ApplicationCatalog {
    /// Lists all installed applications with real-time process monitoring and disk metric resolution
    pub fn list_applications() -> Result<Vec<InstalledAppInfo>, String> {
        let platform = get_platform();
        let raw_apps = platform.list_installed_apps().map_err(|e| e.to_string())?;

        let procs = platform.list_running_processes().unwrap_or_default();
        let running_names: HashSet<String> =
            procs.into_iter().map(|p| p.name.to_lowercase()).collect();

        let apps: Vec<InstalledAppInfo> = raw_apps
            .into_iter()
            .map(|raw| {
                let lower_name = raw.name.to_lowercase();
                let is_running = running_names.iter().any(|p| {
                    p.contains(&lower_name) || lower_name.contains(p.trim_end_matches(".exe"))
                });

                // If estimated size is missing in registry, attempt to resolve from install_location
                let estimated_size_bytes = match raw.estimated_size_bytes {
                    Some(s) if s > 0 => Some(s),
                    _ => raw.install_location.as_ref().and_then(|loc| {
                        let p = Path::new(loc);
                        if p.exists() && p.is_dir() {
                            Self::quick_dir_size(p)
                        } else {
                            None
                        }
                    }),
                };

                InstalledAppInfo {
                    id: raw.id,
                    name: raw.name,
                    publisher: raw.publisher,
                    display_version: raw.display_version,
                    install_location: raw.install_location,
                    uninstall_string: raw.uninstall_string,
                    estimated_size_bytes,
                    install_date: raw.install_date,
                    is_running,
                    display_icon: raw.display_icon,
                    icon_data: raw.icon_data,
                }
            })
            .collect();

        Ok(apps)
    }

    /// Fast directory size computation (capped at 50,000 files for responsiveness)
    fn quick_dir_size(path: &Path) -> Option<u64> {
        let mut total = 0u64;
        let mut count = 0usize;

        for entry in WalkDir::new(path)
            .min_depth(1)
            .follow_links(false)
            .into_iter()
            .filter_map(|e| e.ok())
        {
            count += 1;
            if count > 50_000 {
                break;
            }
            if let Ok(meta) = entry.metadata() {
                if meta.is_file() {
                    total += meta.len();
                }
            }
        }

        if total > 0 {
            Some(total)
        } else {
            None
        }
    }
}
