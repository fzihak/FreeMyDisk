use crate::shared::errors::CoreError;
use freemydisk_platform::traits::PlatformFilesystem;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CondaCacheInfo {
    pub found: bool,
    pub conda_path: Option<String>,
    pub cache_dirs: Vec<String>,
    pub total_size_bytes: u64,
    pub package_count: usize,
}

pub struct CondaCleaner;

impl CondaCleaner {
    /// Scans Conda/Miniconda/Anaconda package caches.
    pub fn scan() -> CondaCacheInfo {
        let home = match std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")) {
            Ok(h) => PathBuf::from(h),
            Err(_) => {
                return CondaCacheInfo {
                    found: false,
                    conda_path: None,
                    cache_dirs: Vec::new(),
                    total_size_bytes: 0,
                    package_count: 0,
                }
            }
        };

        let local_appdata = std::env::var("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|_| home.join("AppData").join("Local"));

        let candidate_pkgs = [
            home.join("miniconda3").join("pkgs"),
            home.join("anaconda3").join("pkgs"),
            home.join("miniforge3").join("pkgs"),
            home.join(".conda").join("pkgs"),
            local_appdata.join("conda").join("conda").join("pkgs"),
        ];

        let mut cache_dirs = Vec::new();
        let mut total_size_bytes = 0u64;
        let mut package_count = 0usize;

        for pkgs_dir in &candidate_pkgs {
            if pkgs_dir.exists() {
                cache_dirs.push(pkgs_dir.to_string_lossy().to_string());
                for entry in WalkDir::new(pkgs_dir).max_depth(2).into_iter().flatten() {
                    let path = entry.path();
                    if entry.file_type().is_file() {
                        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
                        if name.ends_with(".conda") || name.ends_with(".tar.bz2") {
                            total_size_bytes += entry.metadata().map(|m| m.len()).unwrap_or(0);
                            package_count += 1;
                        }
                    }
                }
            }
        }

        let conda_path = Self::find_conda_binary();
        let found = !cache_dirs.is_empty() || conda_path.is_some();

        CondaCacheInfo {
            found,
            conda_path,
            cache_dirs,
            total_size_bytes,
            package_count,
        }
    }

    /// Safely cleans downloaded Conda package tarballs (.conda, .tar.bz2).
    /// Uses conda clean CLI if available, otherwise trashes package tarballs directly.
    pub fn clean_cache(platform: &dyn PlatformFilesystem) -> Result<u64, CoreError> {
        let scan_result = Self::scan();
        if !scan_result.found || scan_result.total_size_bytes == 0 {
            return Ok(0);
        }

        // Try conda clean --packages --tarballs --yes
        if let Some(ref conda_bin) = scan_result.conda_path {
            if let Ok(mut child) = std::process::Command::new(conda_bin)
                .args(["clean", "--packages", "--tarballs", "--yes"])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
            {
                if let Ok(status) = child.wait() {
                    if status.success() {
                        return Ok(scan_result.total_size_bytes);
                    }
                }
            }
        }

        // Fallback: trash .conda and .tar.bz2 files in cache dirs
        let mut freed_bytes = 0u64;
        for dir_str in &scan_result.cache_dirs {
            let dir_path = Path::new(dir_str);
            if dir_path.exists() {
                for entry in WalkDir::new(dir_path).max_depth(2).into_iter().flatten() {
                    let path = entry.path();
                    if entry.file_type().is_file() {
                        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
                        if name.ends_with(".conda") || name.ends_with(".tar.bz2") {
                            let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                            if platform.trash_path(path).is_ok() {
                                freed_bytes += size;
                            }
                        }
                    }
                }
            }
        }

        Ok(freed_bytes)
    }

    fn find_conda_binary() -> Option<String> {
        if let Ok(output) = std::process::Command::new("conda")
            .arg("--version")
            .output()
        {
            if output.status.success() {
                return Some("conda".to_string());
            }
        }

        let home = std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .ok()?;
        let candidate_bins = [
            PathBuf::from(&home)
                .join("miniconda3")
                .join("Scripts")
                .join("conda.exe"),
            PathBuf::from(&home)
                .join("anaconda3")
                .join("Scripts")
                .join("conda.exe"),
            PathBuf::from(&home)
                .join("miniforge3")
                .join("Scripts")
                .join("conda.exe"),
        ];

        for b in &candidate_bins {
            if b.exists() {
                return Some(b.to_string_lossy().to_string());
            }
        }

        None
    }
}
