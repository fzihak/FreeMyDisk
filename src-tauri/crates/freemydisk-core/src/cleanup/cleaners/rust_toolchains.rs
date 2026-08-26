use crate::shared::errors::CoreError;
use freemydisk_platform::traits::PlatformFilesystem;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RustToolchainInfo {
    pub name: String,
    pub path: String,
    pub is_active: bool,
    pub size_bytes: u64,
    pub modified_at: Option<u64>,
    pub channel: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RustToolchainScanResult {
    pub toolchains: Vec<RustToolchainInfo>,
    pub total_size_bytes: u64,
    pub active_toolchain: Option<String>,
    pub rustup_installed: bool,
}

pub struct RustToolchainCleaner;

impl RustToolchainCleaner {
    /// Discovers installed Rust toolchains via rustup and `%USERPROFILE%\.rustup\toolchains`.
    pub fn scan() -> Result<RustToolchainScanResult, CoreError> {
        let rustup_home = Self::get_rustup_home();
        let toolchains_dir = rustup_home.join("toolchains");

        let (active_toolchain, rustup_installed) = Self::detect_active_toolchain(&rustup_home);

        if !toolchains_dir.exists() {
            return Ok(RustToolchainScanResult {
                toolchains: Vec::new(),
                total_size_bytes: 0,
                active_toolchain,
                rustup_installed,
            });
        }

        let mut toolchains = Vec::new();
        let mut total_size_bytes = 0u64;

        if let Ok(entries) = fs::read_dir(&toolchains_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    let name = match path.file_name().and_then(|n| n.to_str()) {
                        Some(n) => n.to_string(),
                        None => continue,
                    };

                    let is_active = active_toolchain
                        .as_ref()
                        .map(|act| act == &name || name.starts_with(act))
                        .unwrap_or(false);

                    let size_bytes = Self::calculate_dir_size(&path);
                    total_size_bytes += size_bytes;

                    let modified_at = entry
                        .metadata()
                        .ok()
                        .and_then(|m| m.modified().ok())
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_secs());

                    let channel = Self::detect_channel(&name);

                    toolchains.push(RustToolchainInfo {
                        name,
                        path: path.to_string_lossy().to_string(),
                        is_active,
                        size_bytes,
                        modified_at,
                        channel,
                    });
                }
            }
        }

        // Sort: inactive toolchains first (best candidates for removal), then descending by size
        toolchains.sort_by(|a, b| {
            if a.is_active != b.is_active {
                a.is_active.cmp(&b.is_active)
            } else {
                b.size_bytes.cmp(&a.size_bytes)
            }
        });

        Ok(RustToolchainScanResult {
            toolchains,
            total_size_bytes,
            active_toolchain,
            rustup_installed,
        })
    }

    /// Safely cleans / uninstalls a toolchain.
    /// Invariant: Refuses to delete the active default toolchain unless `force_active` is explicitly set.
    pub fn clean_toolchain(
        name_or_path: &str,
        force_active: bool,
        platform: &dyn PlatformFilesystem,
    ) -> Result<u64, CoreError> {
        let rustup_home = Self::get_rustup_home();
        let toolchains_dir = rustup_home.join("toolchains");

        // Determine toolchain name and full directory path
        let (toolchain_name, dir_path) = if Path::new(name_or_path).is_absolute() {
            let pb = PathBuf::from(name_or_path);
            let name = pb
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or(name_or_path)
                .to_string();
            (name, pb)
        } else {
            (name_or_path.to_string(), toolchains_dir.join(name_or_path))
        };

        if !dir_path.exists() {
            return Ok(0);
        }

        // Verify active status
        let (active_toolchain, _) = Self::detect_active_toolchain(&rustup_home);
        if let Some(active) = active_toolchain {
            if (active == toolchain_name || toolchain_name.starts_with(&active)) && !force_active {
                return Err(CoreError::Validation(format!(
                    "Toolchain '{}' is the active default. Uninstallation blocked to protect build environment.",
                    toolchain_name
                )));
            }
        }

        let size_freed = Self::calculate_dir_size(&dir_path);

        // First attempt clean uninstall via `rustup toolchain uninstall <name>`
        let mut uninstalled_via_cli = false;
        if let Ok(mut child) = std::process::Command::new("rustup")
            .args(["toolchain", "uninstall", &toolchain_name])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
        {
            if let Ok(status) = child.wait() {
                if status.success() {
                    uninstalled_via_cli = true;
                }
            }
        }

        // If directory still exists or rustup is not in PATH, use PlatformFilesystem trash (Trash-First)
        if dir_path.exists() {
            platform
                .trash_path(&dir_path)
                .map_err(CoreError::Platform)?;
        } else if !uninstalled_via_cli {
            return Err(CoreError::NotFound(format!(
                "Toolchain directory disappeared unexpectedly: {}",
                dir_path.display()
            )));
        }

        Ok(size_freed)
    }

    fn get_rustup_home() -> PathBuf {
        if let Ok(rh) = std::env::var("RUSTUP_HOME") {
            return PathBuf::from(rh);
        }

        let home = match std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")) {
            Ok(h) => PathBuf::from(h),
            Err(_) => PathBuf::from("."),
        };

        home.join(".rustup")
    }

    fn detect_active_toolchain(rustup_home: &Path) -> (Option<String>, bool) {
        // Try `rustup toolchain list`
        if let Ok(output) = std::process::Command::new("rustup")
            .args(["toolchain", "list"])
            .output()
        {
            if output.status.success() {
                let text = String::from_utf8_lossy(&output.stdout);
                for line in text.lines() {
                    let trimmed = line.trim();
                    if trimmed.ends_with("(default)") {
                        let name = trimmed.trim_end_matches("(default)").trim().to_string();
                        return (Some(name), true);
                    }
                }
                return (None, true);
            }
        }

        // Fallback: Read .rustup/settings.toml
        let settings_file = rustup_home.join("settings.toml");
        if settings_file.exists() {
            if let Ok(content) = fs::read_to_string(&settings_file) {
                for line in content.lines() {
                    let trimmed = line.trim();
                    if trimmed.starts_with("default_toolchain") {
                        if let Some((_, val)) = trimmed.split_once('=') {
                            let clean_val = val.trim().trim_matches('"').trim_matches('\'');
                            return (Some(clean_val.to_string()), false);
                        }
                    }
                }
            }
        }

        (None, false)
    }

    fn detect_channel(name: &str) -> String {
        let lower = name.to_lowercase();
        if lower.starts_with("stable") {
            "stable".to_string()
        } else if lower.starts_with("nightly") {
            "nightly".to_string()
        } else if lower.starts_with("beta") {
            "beta".to_string()
        } else {
            "custom".to_string()
        }
    }

    pub fn calculate_dir_size(dir: &Path) -> u64 {
        WalkDir::new(dir)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().is_file())
            .filter_map(|e| e.metadata().ok())
            .map(|m| m.len())
            .sum()
    }
}
