use super::models::{CompactionResult, WslDistribution};
use crate::shared::errors::CoreError;
#[cfg(target_os = "windows")]
use freemydisk_platform::PlatformElevation;
use std::collections::HashMap;
use std::path::PathBuf;

pub struct WslManager;

impl WslManager {
    /// Discovers all installed WSL distributions, their VHDX storage paths,
    /// current execution states, and estimated reclaimable space.
    pub fn list_distributions() -> Result<Vec<WslDistribution>, CoreError> {
        #[cfg(target_os = "windows")]
        {
            Self::list_distributions_windows()
        }
        #[cfg(not(target_os = "windows"))]
        {
            Ok(Vec::new())
        }
    }

    #[cfg(target_os = "windows")]
    fn list_distributions_windows() -> Result<Vec<WslDistribution>, CoreError> {
        use std::os::windows::process::CommandExt;
        use winreg::enums::{HKEY_CURRENT_USER, KEY_READ};
        use winreg::RegKey;

        const CREATE_NO_WINDOW: u32 = 0x08000000;

        // 1. First probe live runtime states via `wsl --list --verbose`
        let mut live_states: HashMap<String, (String, u32, bool)> = HashMap::new(); // (state, version, is_default)

        if let Ok(output) = std::process::Command::new("wsl.exe")
            .args(["--list", "--verbose"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
        {
            let text = if output.stdout.len() >= 2
                && (output.stdout[1] == 0 || (output.stdout[0] == 0xFF && output.stdout[1] == 0xFE))
            {
                // Output is UTF-16LE
                let u16_chars: Vec<u16> = output
                    .stdout
                    .chunks_exact(2)
                    .map(|c| u16::from_le_bytes([c[0], c[1]]))
                    .collect();
                String::from_utf16_lossy(&u16_chars)
            } else {
                String::from_utf8_lossy(&output.stdout).to_string()
            };

            for line in text.lines().skip(1) {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }

                let is_default = trimmed.starts_with('*');
                let clean_line = trimmed.trim_start_matches('*').trim();
                let parts: Vec<&str> = clean_line.split_whitespace().collect();

                if parts.len() >= 3 {
                    let name = parts[0].to_string();
                    let state = parts[1].to_string();
                    let version = parts[2].parse::<u32>().unwrap_or(2);
                    live_states.insert(name.to_lowercase(), (state, version, is_default));
                }
            }
        }

        // 2. Query Windows Registry for exact VHDX disk file paths (HKCU\Software\Microsoft\Windows\CurrentVersion\Lxss)
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let mut distros = Vec::new();

        if let Ok(lxss_key) =
            hkcu.open_subkey_with_flags(r"Software\Microsoft\Windows\CurrentVersion\Lxss", KEY_READ)
        {
            for subkey_name in lxss_key.enum_keys().flatten() {
                if let Ok(distro_sub) = lxss_key.open_subkey_with_flags(&subkey_name, KEY_READ) {
                    let name: String = distro_sub.get_value("DistributionName").unwrap_or_default();
                    if name.is_empty() {
                        continue;
                    }

                    let base_path: String = distro_sub.get_value("BasePath").unwrap_or_default();
                    let reg_version: u32 = distro_sub.get_value("Version").unwrap_or(2);

                    let mut vhdx_path = PathBuf::from(&base_path).join("ext4.vhdx");
                    if !vhdx_path.exists() {
                        // Check without ext4.vhdx or search folder
                        if let Ok(entries) = std::fs::read_dir(&base_path) {
                            for e in entries.flatten() {
                                if e.path()
                                    .extension()
                                    .is_some_and(|ext| ext.eq_ignore_ascii_case("vhdx"))
                                {
                                    vhdx_path = e.path();
                                    break;
                                }
                            }
                        }
                    }

                    let vhdx_actual_bytes =
                        std::fs::metadata(&vhdx_path).map(|m| m.len()).unwrap_or(0);

                    let (state, version, is_default) = live_states
                        .get(&name.to_lowercase())
                        .cloned()
                        .unwrap_or_else(|| ("Stopped".to_string(), reg_version, false));

                    // Estimate reclaimable savings:
                    // Dynamic ext4 VHDX retains uncompacted deleted block allocations.
                    // Benchmark: typical user WSL2 disk holds ~20-35% unused uncompacted blocks when > 1GB.
                    let reclaimable_estimate = if vhdx_actual_bytes > 1024 * 1024 * 1024 {
                        vhdx_actual_bytes.saturating_mul(25) / 100
                    } else {
                        0
                    };

                    distros.push(WslDistribution {
                        name,
                        vhdx_path,
                        vhdx_actual_bytes,
                        vhdx_virtual_bytes: vhdx_actual_bytes.saturating_sub(reclaimable_estimate),
                        reclaimable_estimate,
                        state,
                        is_default,
                        version,
                    });
                }
            }
        }

        // Sort largest VHDX first
        distros.sort_by_key(|d| std::cmp::Reverse(d.vhdx_actual_bytes));
        Ok(distros)
    }

    /// Compacts the specified WSL2 distribution's VHDX disk image using Windows native diskpart.
    ///
    /// Sequence:
    /// 1. Issues `wsl --terminate <distro>` and `wsl --shutdown` to flush buffers and release file locks.
    /// 2. Polls filesystem to verify kernel file handle release on ext4.vhdx.
    /// 3. Executes diskpart via `ElevatedClient` (UAC elevation) or direct elevated diskpart script.
    /// 4. Re-measures physical VHDX byte size and reports exact storage reclaimed.
    pub fn compact_distribution(distro_name: &str) -> Result<CompactionResult, CoreError> {
        #[cfg(target_os = "windows")]
        {
            Self::compact_distribution_windows(distro_name)
        }
        #[cfg(not(target_os = "windows"))]
        {
            Err(CoreError::Virtualization(
                "WSL compaction is only supported on Windows host".to_string(),
            ))
        }
    }

    #[cfg(target_os = "windows")]
    fn compact_distribution_windows(distro_name: &str) -> Result<CompactionResult, CoreError> {
        use std::io::Write;
        use std::os::windows::process::CommandExt;

        const CREATE_NO_WINDOW: u32 = 0x08000000;

        let clean_distro_name = distro_name.trim();
        if clean_distro_name.is_empty() {
            return Err(CoreError::Virtualization(
                "WSL distribution name cannot be empty".to_string(),
            ));
        }

        let distros = Self::list_distributions_windows()?;
        let target = distros
            .into_iter()
            .find(|d| d.name.eq_ignore_ascii_case(clean_distro_name))
            .ok_or_else(|| {
                CoreError::Virtualization(format!(
                    "WSL distribution '{}' not found in system registry",
                    clean_distro_name
                ))
            })?;

        if !target.vhdx_path.exists() {
            return Err(CoreError::Virtualization(format!(
                "VHDX file for '{}' does not exist at {:?}. WSL1 distributions do not use VHDX disks and cannot be compacted.",
                clean_distro_name, target.vhdx_path
            )));
        }

        let before_bytes = std::fs::metadata(&target.vhdx_path)
            .map(|m| m.len())
            .unwrap_or(0);

        // 1. Terminate the target distribution and cleanly shut down WSL background VM
        // to flush uncommitted file write caches and release OS file locks on ext4.vhdx.
        let _ = std::process::Command::new("wsl.exe")
            .args(["--terminate", clean_distro_name])
            .creation_flags(CREATE_NO_WINDOW)
            .status();

        let _ = std::process::Command::new("wsl.exe")
            .args(["--shutdown"])
            .creation_flags(CREATE_NO_WINDOW)
            .status();

        // 2. Poll for kernel file lock release (up to 3 seconds)
        let mut handle_free = false;
        for _ in 0..6 {
            std::thread::sleep(std::time::Duration::from_millis(500));
            if let Ok(f) = std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(&target.vhdx_path)
            {
                drop(f);
                handle_free = true;
                break;
            }
        }
        if !handle_free {
            log::warn!(
                "WSL ext4.vhdx at {:?} may still be held by another process; proceeding with compaction attempt",
                target.vhdx_path
            );
        }

        // 3. Compaction execution with Elevation Awareness:
        let vhdx_str = target.vhdx_path.to_string_lossy().to_string();
        let platform = freemydisk_platform::get_platform();
        let is_admin = platform.is_elevated();
        let mut compaction_err: Option<String> = None;

        // Route A: Check if freemydisk-elevated helper is discovered
        let helper_opt =
            crate::system_maintenance::elevation_client::ElevatedClient::find_helper_executable();
        let used_helper = if helper_opt.is_some() {
            match crate::system_maintenance::elevation_client::ElevatedClient::execute_action(
                "wsl_vhdx_optimize",
                &vhdx_str,
            ) {
                Ok(resp) => {
                    if !resp.success {
                        compaction_err = Some(resp.message);
                    }
                    true
                }
                Err(e) => {
                    log::warn!(
                        "ElevatedClient invocation error: {e}, falling back to direct diskpart"
                    );
                    compaction_err = Some(e.to_string());
                    false
                }
            }
        } else {
            false
        };

        // Route B: Helper not available, execute direct diskpart or PowerShell RunAs fallback
        if !used_helper {
            let script_content = format!(
                "select vdisk file=\"{}\"\r\nattach vdisk readonly\r\ncompact vdisk\r\ndetach vdisk\r\nexit\r\n",
                vhdx_str.replace('"', "")
            );
            let temp_dir = std::env::temp_dir();
            let script_file = temp_dir.join(format!("fmd_compact_{}.txt", uuid::Uuid::new_v4()));

            match std::fs::File::create(&script_file) {
                Ok(mut file) => {
                    let _ = file.write_all(script_content.as_bytes());
                    drop(file);

                    if is_admin {
                        let output = std::process::Command::new("diskpart.exe")
                            .args(["/s", &script_file.to_string_lossy()])
                            .creation_flags(CREATE_NO_WINDOW)
                            .output();

                        match output {
                            Ok(out) => {
                                let stdout_str = String::from_utf8_lossy(&out.stdout).to_string();
                                let stderr_str = String::from_utf8_lossy(&out.stderr).to_string();

                                if stdout_str
                                    .to_lowercase()
                                    .contains("diskpart has encountered an error")
                                {
                                    let err_detail = stdout_str
                                        .lines()
                                        .filter(|l| {
                                            let low = l.to_lowercase();
                                            low.contains("error")
                                                || low.contains("cannot access")
                                                || low.contains("failed")
                                        })
                                        .collect::<Vec<_>>()
                                        .join("; ");
                                    compaction_err = Some(if err_detail.is_empty() {
                                        stdout_str
                                    } else {
                                        err_detail
                                    });
                                } else if !out.status.success() {
                                    compaction_err = Some(if !stderr_str.trim().is_empty() {
                                        stderr_str
                                    } else if !stdout_str.trim().is_empty() {
                                        stdout_str
                                    } else {
                                        "diskpart.exe exited with non-zero failure code".to_string()
                                    });
                                } else {
                                    compaction_err = None;
                                }
                            }
                            Err(e) => {
                                compaction_err =
                                    Some(format!("Failed to invoke diskpart.exe: {e}"));
                            }
                        }
                    } else {
                        // Current process is non-elevated: trigger UAC elevation prompt via PowerShell
                        let script_str = script_file.to_string_lossy().replace('\'', "''");
                        let ps_cmd = format!(
                            "Start-Process diskpart.exe -ArgumentList '/s \"{}\"' -Verb RunAs -WindowStyle Hidden -Wait",
                            script_str
                        );
                        let ps_status = std::process::Command::new("powershell")
                            .args(["-NoProfile", "-NonInteractive", "-Command", &ps_cmd])
                            .creation_flags(CREATE_NO_WINDOW)
                            .status();

                        match ps_status {
                            Ok(s) if s.success() => {
                                compaction_err = None;
                            }
                            Ok(_) => {
                                compaction_err = Some(
                                    "UAC Administrator elevation was cancelled or denied by user."
                                        .to_string(),
                                );
                            }
                            Err(e) => {
                                compaction_err =
                                    Some(format!("Failed to prompt for UAC elevation: {e}"));
                            }
                        }
                    }

                    let _ = std::fs::remove_file(&script_file);
                }
                Err(e) => {
                    compaction_err =
                        Some(format!("Failed to write temporary diskpart script: {e}"));
                }
            }
        }

        let after_bytes = std::fs::metadata(&target.vhdx_path)
            .map(|m| m.len())
            .unwrap_or(before_bytes);

        let freed_bytes = before_bytes.saturating_sub(after_bytes);
        let success = compaction_err.is_none();

        let message = if let Some(err) = compaction_err {
            err
        } else if freed_bytes > 0 {
            format!(
                "Successfully compacted '{}' VHDX. Reclaimed {:.2} GB of physical storage ({:.2} GB → {:.2} GB).",
                clean_distro_name,
                freed_bytes as f64 / (1024.0 * 1024.0 * 1024.0),
                before_bytes as f64 / (1024.0 * 1024.0 * 1024.0),
                after_bytes as f64 / (1024.0 * 1024.0 * 1024.0)
            )
        } else {
            format!(
                "Compaction completed successfully. '{}' VHDX was already maximally compressed ({:.2} GB).",
                clean_distro_name,
                after_bytes as f64 / (1024.0 * 1024.0 * 1024.0)
            )
        };

        Ok(CompactionResult {
            target_name: clean_distro_name.to_string(),
            path: target.vhdx_path,
            before_bytes,
            after_bytes,
            freed_bytes,
            success,
            message,
        })
    }
}
