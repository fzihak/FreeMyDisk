use super::models::{DockerInfo, DockerSpaceCategory};
use crate::shared::errors::CoreError;

pub struct DockerManager;

impl DockerManager {
    /// Detects Docker installation, checks if daemon is running,
    /// and queries space usage across Images, Containers, Volumes, and Build Cache.
    pub fn get_docker_info() -> DockerInfo {
        #[cfg(target_os = "windows")]
        {
            Self::get_docker_info_windows()
        }
        #[cfg(not(target_os = "windows"))]
        {
            DockerInfo {
                is_installed: false,
                is_running: false,
                server_version: None,
                storage_driver: None,
                data_root: None,
                total_space_bytes: 0,
                total_reclaimable_bytes: 0,
                categories: Vec::new(),
            }
        }
    }

    #[cfg(target_os = "windows")]
    fn get_docker_info_windows() -> DockerInfo {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;

        let docker_cmd = Self::resolve_docker_binary();

        let binary = match docker_cmd {
            Some(b) => b,
            None => {
                return DockerInfo {
                    is_installed: false,
                    is_running: false,
                    server_version: None,
                    storage_driver: None,
                    data_root: None,
                    total_space_bytes: 0,
                    total_reclaimable_bytes: 0,
                    categories: Vec::new(),
                };
            }
        };

        // Check if Docker daemon is running
        let version_res = std::process::Command::new(&binary)
            .args(["version", "--format", "{{.Server.Version}}"])
            .creation_flags(CREATE_NO_WINDOW)
            .output();

        let (is_running, server_version) = match version_res {
            Ok(output) if output.status.success() => {
                let v = String::from_utf8_lossy(&output.stdout).trim().to_string();
                (true, if v.is_empty() { None } else { Some(v) })
            }
            _ => (false, None),
        };

        if !is_running {
            return DockerInfo {
                is_installed: true,
                is_running: false,
                server_version: None,
                storage_driver: None,
                data_root: None,
                total_space_bytes: 0,
                total_reclaimable_bytes: 0,
                categories: Vec::new(),
            };
        }

        // Parse docker system df
        let df_res = std::process::Command::new(&binary)
            .args(["system", "df", "--format", "{{json .}}"])
            .creation_flags(CREATE_NO_WINDOW)
            .output();

        let mut categories = Vec::new();
        let mut total_space = 0u64;
        let mut total_reclaimable = 0u64;

        if let Ok(output) = df_res {
            if output.status.success() {
                let text = String::from_utf8_lossy(&output.stdout);
                for line in text.lines() {
                    let trimmed = line.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(trimmed) {
                        let cat_type = v
                            .get("Type")
                            .and_then(|t| t.as_str())
                            .unwrap_or("Unknown")
                            .to_string();
                        let total_cnt =
                            v.get("TotalCount").and_then(|c| c.as_u64()).unwrap_or(0) as usize;
                        let active_cnt =
                            v.get("Active").and_then(|c| c.as_u64()).unwrap_or(0) as usize;
                        let size_str = v.get("Size").and_then(|s| s.as_str()).unwrap_or("0B");
                        let recl_str = v
                            .get("Reclaimable")
                            .and_then(|r| r.as_str())
                            .unwrap_or("0B");

                        let size_bytes = Self::parse_size_str(size_str);
                        let recl_bytes = Self::parse_size_str(recl_str);

                        total_space += size_bytes;
                        total_reclaimable += recl_bytes;

                        categories.push(DockerSpaceCategory {
                            category: cat_type,
                            total_count: total_cnt,
                            active_count: active_cnt,
                            size_bytes,
                            reclaimable_bytes: recl_bytes,
                        });
                    }
                }
            }
        }

        DockerInfo {
            is_installed: true,
            is_running: true,
            server_version,
            storage_driver: Some("overlay2 / WSL2 ext4".to_string()),
            data_root: Some(r"\\wsl$\docker-desktop-data\data".to_string()),
            total_space_bytes: total_space,
            total_reclaimable_bytes: total_reclaimable,
            categories,
        }
    }

    /// Executes safe Docker pruning for the requested target
    /// Target types: "build_cache", "images", "containers", "volumes", "all"
    pub fn prune(target: &str) -> Result<u64, CoreError> {
        #[cfg(target_os = "windows")]
        {
            Self::prune_windows(target)
        }
        #[cfg(not(target_os = "windows"))]
        {
            Err(CoreError::Other(
                "Docker prune only supported on Windows host".to_string(),
            ))
        }
    }

    #[cfg(target_os = "windows")]
    fn prune_windows(target: &str) -> Result<u64, CoreError> {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;

        let binary = Self::resolve_docker_binary().ok_or_else(|| {
            CoreError::Virtualization("Docker CLI not found on system".to_string())
        })?;

        let args: &[&str] = match target {
            "build_cache" => &["builder", "prune", "-f"],
            "images" => &["image", "prune", "-f"],
            "containers" => &["container", "prune", "-f"],
            "volumes" => &["volume", "prune", "-f"],
            _ => &["system", "prune", "-f"],
        };

        let output = std::process::Command::new(&binary)
            .args(args)
            .creation_flags(CREATE_NO_WINDOW)
            .output()?;

        if !output.status.success() {
            let err = String::from_utf8_lossy(&output.stderr);
            return Err(CoreError::Virtualization(format!(
                "Docker prune failed: {}",
                err
            )));
        }

        let text = String::from_utf8_lossy(&output.stdout);
        // Look for pattern "Total reclaimed space: 1.25GB"
        let mut reclaimed = 0u64;
        for line in text.lines() {
            if line.contains("Total reclaimed space:") {
                let parts: Vec<&str> = line.split(':').collect();
                if parts.len() >= 2 {
                    reclaimed = Self::parse_size_str(parts[1].trim());
                }
            }
        }

        Ok(reclaimed)
    }

    fn resolve_docker_binary() -> Option<String> {
        // 1. Check in PATH
        if which_exists("docker.exe") {
            return Some("docker.exe".to_string());
        }

        // 2. Check standard Docker Desktop installation paths
        let standard_paths = [
            r"C:\Program Files\Docker\Docker\resources\bin\docker.exe",
            r"C:\Program Files\Docker\Docker\resources\docker.exe",
        ];

        for p in &standard_paths {
            if std::path::Path::new(p).exists() {
                return Some(p.to_string());
            }
        }

        None
    }

    fn parse_size_str(s: &str) -> u64 {
        let clean = s.trim().to_uppercase();
        // E.g. "1.25GB (50%)" -> take first token
        let token = clean.split_whitespace().next().unwrap_or("0");

        let (num_part, unit) = if token.ends_with("TIB") || token.ends_with("TB") {
            (
                token.trim_end_matches("TIB").trim_end_matches("TB"),
                1024u64 * 1024 * 1024 * 1024,
            )
        } else if token.ends_with("GIB") || token.ends_with("GB") {
            (
                token.trim_end_matches("GIB").trim_end_matches("GB"),
                1024u64 * 1024 * 1024,
            )
        } else if token.ends_with("MIB") || token.ends_with("MB") {
            (
                token.trim_end_matches("MIB").trim_end_matches("MB"),
                1024u64 * 1024,
            )
        } else if token.ends_with("KIB") || token.ends_with("KB") {
            (
                token.trim_end_matches("KIB").trim_end_matches("KB"),
                1024u64,
            )
        } else if token.ends_with('B') {
            (token.trim_end_matches('B'), 1u64)
        } else {
            (token, 1u64)
        };

        let val: f64 = num_part.trim().parse().unwrap_or(0.0);
        (val * unit as f64) as u64
    }
}

fn which_exists(cmd: &str) -> bool {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        std::process::Command::new("where.exe")
            .arg(cmd)
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .is_ok_and(|o| o.status.success())
    }
    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}
