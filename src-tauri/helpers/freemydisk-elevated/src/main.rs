use serde::{Deserialize, Serialize};
use std::io::{self, Read, Write};
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::path::PathBuf;

fn hidden_cmd(prog: &str) -> std::process::Command {
    #[cfg(target_os = "windows")]
    {
        let mut cmd = std::process::Command::new(prog);
        cmd.creation_flags(0x08000000);
        cmd
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::process::Command::new(prog)
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ElevatedRequest {
    pub operation: String,
    pub payload: String,
    #[serde(default)]
    pub token: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ElevatedResponse {
    pub success: bool,
    pub message: String,
}

const ALLOWED_SERVICES: &[&str] = &["wsearch", "wuauserv", "bits"];

fn handle_request(req: ElevatedRequest, expected_token: Option<&str>) -> ElevatedResponse {
    // 1. Session Token Authentication Verification (§9.2)
    if let Some(expected) = expected_token {
        match req.token.as_deref() {
            Some(t) if t == expected => {}
            _ => {
                return ElevatedResponse {
                    success: false,
                    message: "Authentication failed: invalid or mismatched session token"
                        .to_string(),
                };
            }
        }
    }

    // 2. Strict RBAC Operation Dispatch
    match req.operation.as_str() {
        "service_stop" => {
            let svc = req.payload.trim().to_lowercase();
            if !ALLOWED_SERVICES.contains(&svc.as_str()) {
                return ElevatedResponse {
                    success: false,
                    message: format!("Service '{}' is not in the elevation allowlist", svc),
                };
            }
            let output = hidden_cmd("net").args(["stop", &svc]).output();
            match output {
                Ok(out) if out.status.success() => ElevatedResponse {
                    success: true,
                    message: format!("Service '{}' stopped successfully", svc),
                },
                Ok(out) => ElevatedResponse {
                    success: false,
                    message: String::from_utf8_lossy(&out.stderr).to_string(),
                },
                Err(e) => ElevatedResponse {
                    success: false,
                    message: format!("Failed to invoke net stop: {}", e),
                },
            }
        }

        "service_start" => {
            let svc = req.payload.trim().to_lowercase();
            if !ALLOWED_SERVICES.contains(&svc.as_str()) {
                return ElevatedResponse {
                    success: false,
                    message: format!("Service '{}' is not in the elevation allowlist", svc),
                };
            }
            let output = hidden_cmd("net").args(["start", &svc]).output();
            match output {
                Ok(out) if out.status.success() => ElevatedResponse {
                    success: true,
                    message: format!("Service '{}' started successfully", svc),
                },
                Ok(out) => ElevatedResponse {
                    success: false,
                    message: String::from_utf8_lossy(&out.stderr).to_string(),
                },
                Err(e) => ElevatedResponse {
                    success: false,
                    message: format!("Failed to invoke net start: {}", e),
                },
            }
        }

        "network_reset" => {
            let _ = hidden_cmd("netsh").args(["winsock", "reset"]).output();
            let _ = hidden_cmd("netsh").args(["int", "ip", "reset"]).output();
            ElevatedResponse {
                success: true,
                message: "Winsock catalog and TCP/IP stack reset successfully.".to_string(),
            }
        }

        "clean_software_distribution" => {
            let _ = hidden_cmd("net").args(["stop", "wuauserv"]).output();

            let mut deleted = 0;
            if let Ok(windir) = std::env::var("WINDIR") {
                let download_dir = PathBuf::from(windir).join(r"SoftwareDistribution\Download");
                if let Ok(entries) = std::fs::read_dir(&download_dir) {
                    for entry in entries.flatten() {
                        let path = entry.path();
                        let removed = if path.is_file() {
                            std::fs::remove_file(&path).is_ok()
                        } else if path.is_dir() {
                            std::fs::remove_dir_all(&path).is_ok()
                        } else {
                            false
                        };
                        if removed {
                            deleted += 1;
                        }
                    }
                }
            }

            let _ = hidden_cmd("net").args(["start", "wuauserv"]).output();
            ElevatedResponse {
                success: true,
                message: format!("Cleaned {} items from SoftwareDistribution cache.", deleted),
            }
        }

        "rebuild_search_index" => {
            let _ = hidden_cmd("net").args(["stop", "wsearch"]).output();

            if let Ok(prog_data) = std::env::var("PROGRAMDATA") {
                let edb_path = PathBuf::from(prog_data)
                    .join(r"Microsoft\Search\Data\Applications\Windows\Windows.edb");
                let _ = std::fs::remove_file(edb_path);
            }

            let _ = hidden_cmd("net").args(["start", "wsearch"]).output();
            ElevatedResponse {
                success: true,
                message: "Windows Search Index database reset and indexing restarted.".to_string(),
            }
        }

        "empty_user_recycle_bin" => {
            // Payload: the SID of the user whose Recycle Bin is emptied. Only
            // <drive>:\$Recycle.Bin\<SID>\ is touched; desktop.ini is kept.
            let sid = req.payload.trim();
            if !is_valid_user_sid(sid) {
                return ElevatedResponse {
                    success: false,
                    message: "Invalid user SID".to_string(),
                };
            }
            let (deleted, failed) = empty_user_bins(sid);
            ElevatedResponse {
                success: failed == 0,
                message: format!(
                    "Removed {} Recycle Bin entries; {} could not be removed.",
                    deleted, failed
                ),
            }
        }

        "clean_windows_temp" => {
            let mut deleted = 0;
            if let Ok(windir) = std::env::var("WINDIR") {
                let temp_dir = PathBuf::from(windir).join("Temp");
                if let Ok(entries) = std::fs::read_dir(&temp_dir) {
                    for entry in entries.flatten() {
                        let path = entry.path();
                        let removed = if path.is_file() {
                            std::fs::remove_file(&path).is_ok()
                        } else if path.is_dir() {
                            std::fs::remove_dir_all(&path).is_ok()
                        } else {
                            false
                        };
                        if removed {
                            deleted += 1;
                        }
                    }
                }
            }
            ElevatedResponse {
                success: true,
                message: format!("Cleaned {} items from Windows Temp.", deleted),
            }
        }

        "clean_installer_patch_cache" => {
            let mut deleted = 0;
            if let Ok(windir) = std::env::var("WINDIR") {
                let patch_dir = PathBuf::from(windir).join(r"Installer\$PatchCache$");
                if patch_dir.exists() {
                    if let Ok(entries) = std::fs::read_dir(&patch_dir) {
                        for entry in entries.flatten() {
                            let path = entry.path();
                            if std::fs::remove_dir_all(&path).is_ok()
                                || std::fs::remove_file(&path).is_ok()
                            {
                                deleted += 1;
                            }
                        }
                    }
                }
            }
            ElevatedResponse {
                success: true,
                message: format!("Cleaned {} orphaned patch cache files.", deleted),
            }
        }

        "dism_component_cleanup" => {
            let output = hidden_cmd("dism")
                .args(["/Online", "/Cleanup-Image", "/StartComponentCleanup"])
                .output();
            match output {
                Ok(out) if out.status.success() => ElevatedResponse {
                    success: true,
                    message: "DISM Component Store cleanup completed successfully.".to_string(),
                },
                Ok(out) => ElevatedResponse {
                    success: false,
                    message: String::from_utf8_lossy(&out.stderr).to_string(),
                },
                Err(e) => ElevatedResponse {
                    success: false,
                    message: format!("Failed to run DISM: {}", e),
                },
            }
        }

        "sfc_scan" => {
            let output = hidden_cmd("sfc").args(["/scannow"]).output();
            match output {
                Ok(out) if out.status.success() => ElevatedResponse {
                    success: true,
                    message: "System File Checker scan completed successfully.".to_string(),
                },
                Ok(out) => ElevatedResponse {
                    success: false,
                    message: String::from_utf8_lossy(&out.stderr).to_string(),
                },
                Err(e) => ElevatedResponse {
                    success: false,
                    message: format!("Failed to run SFC: {}", e),
                },
            }
        }

        "system_integrity_repair" => {
            let _ = hidden_cmd("dism")
                .args(["/Online", "/Cleanup-Image", "/RestoreHealth"])
                .output();
            let sfc = hidden_cmd("sfc").args(["/scannow"]).output();
            match sfc {
                Ok(out) if out.status.success() => ElevatedResponse {
                    success: true,
                    message: "System integrity repair completed (DISM health restored & SFC scan verified).".to_string(),
                },
                Ok(out) => ElevatedResponse {
                    success: true,
                    message: format!("DISM repair finished. SFC output: {}", String::from_utf8_lossy(&out.stdout).trim()),
                },
                Err(e) => ElevatedResponse {
                    success: false,
                    message: format!("Failed to execute system integrity scan: {}", e),
                },
            }
        }

        "print_queue_purge" => {
            let _ = hidden_cmd("net").args(["stop", "spooler"]).output();
            let windir = std::env::var("WINDIR").unwrap_or_else(|_| r"C:\Windows".to_string());
            let spool_printers = PathBuf::from(windir).join(r"System32\spool\PRINTERS");
            let mut purged_count = 0;
            if spool_printers.exists() {
                if let Ok(entries) = std::fs::read_dir(&spool_printers) {
                    for entry in entries.flatten() {
                        let p = entry.path();
                        if p.is_file() && std::fs::remove_file(&p).is_ok() {
                            purged_count += 1;
                        }
                    }
                }
            }
            let _ = hidden_cmd("net").args(["start", "spooler"]).output();
            ElevatedResponse {
                success: true,
                message: format!(
                    "Cleared {} stuck printer spool files; Print Spooler service restarted.",
                    purged_count
                ),
            }
        }

        "audio_service_reset" => {
            let _ = hidden_cmd("net").args(["stop", "audiosrv"]).output();
            let _ = hidden_cmd("net")
                .args(["stop", "AudioEndpointBuilder"])
                .output();
            let _ = hidden_cmd("net")
                .args(["start", "AudioEndpointBuilder"])
                .output();
            let _ = hidden_cmd("net").args(["start", "audiosrv"]).output();
            ElevatedResponse {
                success: true,
                message: "Windows Audio engine and AudioEndpointBuilder restarted successfully."
                    .to_string(),
            }
        }

        "time_service_sync" => {
            let _ = hidden_cmd("net").args(["start", "w32time"]).output();
            let output = hidden_cmd("w32tm").args(["/resync", "/force"]).output();
            match output {
                Ok(o) if o.status.success() => ElevatedResponse {
                    success: true,
                    message: "Windows Time Service resynchronized system clock with NTP servers."
                        .to_string(),
                },
                Ok(o) => {
                    let msg = String::from_utf8_lossy(&o.stdout);
                    ElevatedResponse {
                        success: true,
                        message: if msg.trim().is_empty() {
                            "Time sync completed.".to_string()
                        } else {
                            msg.trim().to_string()
                        },
                    }
                }
                Err(e) => ElevatedResponse {
                    success: false,
                    message: format!("Failed to execute w32tm: {}", e),
                },
            }
        }

        "toggle_hklm_startup" => {
            #[derive(Deserialize)]
            struct TogglePayload {
                #[serde(rename = "entryId", alias = "entry_id")]
                entry_id: String,
                enable: bool,
            }

            match serde_json::from_str::<TogglePayload>(&req.payload) {
                Ok(p) => {
                    if !p.entry_id.starts_with("hklm:run:") {
                        ElevatedResponse {
                            success: false,
                            message: "Invalid startup entry ID: must start with hklm:run:"
                                .to_string(),
                        }
                    } else {
                        use freemydisk_platform::traits::PlatformStartup;
                        let handler = freemydisk_platform::get_platform();
                        match handler.set_startup_entry_state(&p.entry_id, p.enable) {
                            Ok(()) => ElevatedResponse {
                                success: true,
                                message: format!(
                                    "Startup item '{}' state successfully updated to {}.",
                                    p.entry_id,
                                    if p.enable { "enabled" } else { "disabled" }
                                ),
                            },
                            Err(e) => ElevatedResponse {
                                success: false,
                                message: format!("Failed to set startup item state: {}", e),
                            },
                        }
                    }
                }
                Err(e) => ElevatedResponse {
                    success: false,
                    message: format!("Invalid JSON payload for toggle_hklm_startup: {}", e),
                },
            }
        }

        "delete_hklm_startup" => {
            #[derive(Deserialize)]
            struct DeletePayload {
                #[serde(rename = "entryId", alias = "entry_id")]
                entry_id: String,
            }

            match serde_json::from_str::<DeletePayload>(&req.payload) {
                Ok(p) => {
                    if !p.entry_id.starts_with("hklm:run:") {
                        ElevatedResponse {
                            success: false,
                            message: "Invalid startup entry ID: must start with hklm:run:"
                                .to_string(),
                        }
                    } else {
                        use freemydisk_platform::traits::PlatformStartup;
                        let handler = freemydisk_platform::get_platform();
                        match handler.delete_startup_entry(&p.entry_id) {
                            Ok(()) => ElevatedResponse {
                                success: true,
                                message: format!(
                                    "Startup item '{}' successfully removed from Windows startup.",
                                    p.entry_id
                                ),
                            },
                            Err(e) => ElevatedResponse {
                                success: false,
                                message: format!("Failed to remove startup item: {}", e),
                            },
                        }
                    }
                }
                Err(e) => ElevatedResponse {
                    success: false,
                    message: format!("Invalid JSON payload for delete_hklm_startup: {}", e),
                },
            }
        }

        "clean_hklm_registry_leftover" => {
            #[derive(Deserialize)]
            struct RegPayload {
                #[serde(rename = "keyPath", alias = "key_path")]
                key_path: String,
            }

            match serde_json::from_str::<RegPayload>(&req.payload) {
                Ok(p) => {
                    let trimmed = p.key_path.trim();
                    let policy =
                        freemydisk_platform::registry_policy::validate_leftover_key(trimmed);
                    if !trimmed.to_ascii_uppercase().starts_with(r"HKLM\") || policy.is_err() {
                        ElevatedResponse {
                            success: false,
                            message: policy.err().unwrap_or_else(|| {
                                "Only HKLM leftover keys are handled here".to_string()
                            }),
                        }
                    } else {
                        #[cfg(target_os = "windows")]
                        {
                            use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_ALL_ACCESS};
                            use winreg::RegKey;

                            let remaining = &trimmed[5..]; // skip "HKLM\"
                            let (parent_path, child_name) = match remaining.rfind('\\') {
                                Some(idx) => (&remaining[..idx], &remaining[idx + 1..]),
                                None => {
                                    return ElevatedResponse {
                                        success: false,
                                        message: "Cannot delete top-level registry hive"
                                            .to_string(),
                                    };
                                }
                            };

                            let child_lower = child_name.to_lowercase();
                            let whitelist = [
                                "microsoft",
                                "classes",
                                "policies",
                                "registeredapplications",
                                "windows",
                                "clients",
                                "intel",
                                "nvidia",
                                "amd",
                                "freemydisk",
                                "wow6432node",
                                "oem",
                                "device",
                            ];
                            if whitelist.contains(&child_lower.as_str()) {
                                ElevatedResponse {
                                    success: false,
                                    message: format!(
                                        "Refusing to delete system registry key: {}",
                                        child_name
                                    ),
                                }
                            } else {
                                let root = RegKey::predef(HKEY_LOCAL_MACHINE);
                                match root.open_subkey_with_flags(parent_path, KEY_ALL_ACCESS) {
                                    Ok(parent) => match parent.delete_subkey_all(child_name) {
                                        Ok(()) => ElevatedResponse {
                                            success: true,
                                            message: format!(
                                                "Leftover registry key '{}' successfully deleted.",
                                                trimmed
                                            ),
                                        },
                                        Err(e) => ElevatedResponse {
                                            success: false,
                                            message: format!("Failed to delete subkey: {}", e),
                                        },
                                    },
                                    Err(e) => ElevatedResponse {
                                        success: false,
                                        message: format!("Failed to open parent key: {}", e),
                                    },
                                }
                            }
                        }
                        #[cfg(not(target_os = "windows"))]
                        {
                            ElevatedResponse {
                                success: false,
                                message: "Registry operations only supported on Windows"
                                    .to_string(),
                            }
                        }
                    }
                }
                Err(e) => ElevatedResponse {
                    success: false,
                    message: format!(
                        "Invalid JSON payload for clean_hklm_registry_leftover: {}",
                        e
                    ),
                },
            }
        }

        "wsl_vhdx_optimize" => {
            let vhdx_path = req.payload.trim();
            let path = PathBuf::from(vhdx_path);

            // Validation: Path must end with .vhdx and be an existing file
            if !vhdx_path.to_lowercase().ends_with(".vhdx") || !path.is_file() {
                return ElevatedResponse {
                    success: false,
                    message: "Invalid or nonexistent VHDX file path specified".to_string(),
                };
            }

            // Canonical validation defense (§9.2 & §9.3): Reject protected system locations
            let canonical = path.canonicalize().unwrap_or_else(|_| path.clone());
            let canon_upper = canonical.to_string_lossy().to_ascii_uppercase();
            if canon_upper.contains(r"WINDOWS\SYSTEM32")
                || canon_upper.starts_with(r"\\?\C:\WINDOWS")
                || canon_upper.starts_with(r"\\?\C:\BOOT")
            {
                return ElevatedResponse {
                    success: false,
                    message: "Forbidden VHDX path: refers to protected system location".to_string(),
                };
            }

            let clean_path = path.to_string_lossy().replace('"', "");
            let diskpart_script = format!(
                "select vdisk file=\"{}\"\r\nattach vdisk readonly\r\ncompact vdisk\r\ndetach vdisk\r\nexit\r\n",
                clean_path
            );

            let temp_script =
                std::env::temp_dir().join(format!("fmd_diskpart_{}.txt", std::process::id()));
            if std::fs::write(&temp_script, &diskpart_script).is_err() {
                return ElevatedResponse {
                    success: false,
                    message: "Failed to write temporary diskpart script".to_string(),
                };
            }

            let output = hidden_cmd("diskpart")
                .args(["/s", &temp_script.to_string_lossy()])
                .output();

            let _ = std::fs::remove_file(&temp_script);

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
                        ElevatedResponse {
                            success: false,
                            message: if err_detail.is_empty() {
                                stdout_str
                            } else {
                                err_detail
                            },
                        }
                    } else if !out.status.success() {
                        let msg = if !stderr_str.trim().is_empty() {
                            stderr_str
                        } else if !stdout_str.trim().is_empty() {
                            stdout_str
                        } else {
                            "Diskpart process exited with failure code".to_string()
                        };
                        ElevatedResponse {
                            success: false,
                            message: msg,
                        }
                    } else {
                        ElevatedResponse {
                            success: true,
                            message: "VHDX virtual disk compacted successfully.".to_string(),
                        }
                    }
                }
                Err(e) => ElevatedResponse {
                    success: false,
                    message: format!("Failed to execute diskpart: {}", e),
                },
            }
        }

        "create_restore_point" => {
            let raw_desc = if req.payload.trim().is_empty() {
                "FreeMyDisk Pre-Cleanup Snapshot".to_string()
            } else {
                req.payload.trim().to_string()
            };

            // Exploit mitigation: Sanitize characters to strictly alphanumeric, spaces, and hyphens
            let safe_desc: String = raw_desc
                .chars()
                .filter(|c| c.is_alphanumeric() || *c == ' ' || *c == '-' || *c == '_')
                .collect();

            let ps_cmd = format!(
                "Checkpoint-Computer -Description '{}' -RestorePointType 'MODIFY_SETTINGS' -ErrorAction Stop",
                safe_desc
            );
            let output = hidden_cmd("powershell")
                .args(["-NoProfile", "-NonInteractive", "-Command", &ps_cmd])
                .output();

            match output {
                Ok(out) if out.status.success() => ElevatedResponse {
                    success: true,
                    message: format!("System Restore Point '{}' created successfully.", safe_desc),
                },
                Ok(out) => {
                    let err = String::from_utf8_lossy(&out.stderr).to_string();
                    ElevatedResponse {
                        success: false,
                        message: if err.is_empty() {
                            "Failed to create System Restore Point (System Restore may be disabled on this volume)".to_string()
                        } else {
                            err
                        },
                    }
                }
                Err(e) => ElevatedResponse {
                    success: false,
                    message: format!("Failed to run PowerShell Checkpoint-Computer: {}", e),
                },
            }
        }

        _ => ElevatedResponse {
            success: false,
            message: format!(
                "Operation '{}' rejected: not in elevation allowlist",
                req.operation
            ),
        },
    }
}

fn decode_hex(hex: &str) -> Result<Vec<u8>, String> {
    if hex.len() % 2 != 0 || !hex.is_ascii() {
        return Err("malformed hex".to_string());
    }
    (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).map_err(|e| e.to_string()))
        .collect()
}

/// True for a user account SID such as `S-1-5-21-111-222-333-1001`: only
/// digits and dashes, so it can never form `..` or another path.
fn is_valid_user_sid(sid: &str) -> bool {
    let mut parts = sid.split('-');
    parts.next() == Some("S")
        && sid.len() <= 184
        && sid.starts_with("S-1-5-21-")
        && parts.all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
}

/// Deletes every entry in `<drive>:\$Recycle.Bin\<sid>\` on all drives except
/// the top-level desktop.ini. `remove_dir_all` removes links inside the bin
/// without following them. Returns (removed, failed) entry counts.
fn empty_user_bins(sid: &str) -> (u64, u64) {
    let (mut removed, mut failed) = (0u64, 0u64);
    for letter in b'A'..=b'Z' {
        let bin = PathBuf::from(format!("{}:\\$Recycle.Bin\\{}", letter as char, sid));
        let Ok(entries) = std::fs::read_dir(&bin) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            if name.to_string_lossy().eq_ignore_ascii_case("desktop.ini") {
                continue;
            }
            let path = entry.path();
            let is_dir = entry
                .file_type()
                .map(|t| t.is_dir() && !t.is_symlink())
                .unwrap_or(false);
            let ok = if is_dir {
                std::fs::remove_dir_all(&path).is_ok()
            } else {
                std::fs::remove_file(&path)
                    .or_else(|_| std::fs::remove_dir(&path))
                    .is_ok()
            };
            if ok {
                removed += 1;
            } else {
                failed += 1;
            }
        }
    }
    (removed, failed)
}

fn main() {
    let args: Vec<String> = std::env::args().collect();

    // Arguments:
    //   --token <token>          session token the request must carry
    //   --request-hex <hex>      request JSON, hex encoded (used through the UAC prompt;
    //                            the command line cannot be changed after launch)
    //   --response <path>        where to write the response when using --request-hex
    let mut expected_token: Option<String> = None;
    let mut request_hex: Option<String> = None;
    let mut response_file: Option<String> = None;

    let mut i = 1;
    while i < args.len() {
        let value = args.get(i + 1).cloned();
        match (args[i].as_str(), value) {
            ("--token", Some(v)) => expected_token = Some(v),
            ("--request-hex", Some(v)) => request_hex = Some(v),
            ("--response", Some(v)) => response_file = Some(v),
            _ => {
                i += 1;
                continue;
            }
        }
        i += 2;
    }

    if let (Some(hex), Some(output_path)) = (request_hex, response_file) {
        let resp = match decode_hex(&hex).and_then(|bytes| {
            serde_json::from_slice::<ElevatedRequest>(&bytes).map_err(|e| e.to_string())
        }) {
            Ok(req) => handle_request(req, expected_token.as_deref()),
            Err(e) => ElevatedResponse {
                success: false,
                message: format!("Invalid request: {}", e),
            },
        };
        let _ = std::fs::write(
            &output_path,
            serde_json::to_string(&resp).unwrap_or_default(),
        );
        return;
    }

    // Default: read from stdin, write to stdout
    let mut buffer = String::new();
    if io::stdin().read_to_string(&mut buffer).is_ok() {
        if let Ok(req) = serde_json::from_str::<ElevatedRequest>(&buffer) {
            let resp = handle_request(req, expected_token.as_deref());
            if let Ok(json) = serde_json::to_string(&resp) {
                let _ = io::stdout().write_all(json.as_bytes());
            }
        } else {
            let resp = ElevatedResponse {
                success: false,
                message: "Invalid JSON request payload".to_string(),
            };
            if let Ok(json) = serde_json::to_string(&resp) {
                let _ = io::stdout().write_all(json.as_bytes());
            }
        }
    }
}

#[cfg(test)]
mod sid_tests {
    use super::is_valid_user_sid;

    #[test]
    fn only_plain_user_sids_are_accepted() {
        assert!(is_valid_user_sid(
            "S-1-5-21-2105648121-1751983684-3216264173-1001"
        ));
        assert!(!is_valid_user_sid("S-1-5-18"));
        assert!(!is_valid_user_sid("S-1-5-21-1-2-3-1001\\..\\.."));
        assert!(!is_valid_user_sid("S-1-5-21-1-2-3-1001/x"));
        assert!(!is_valid_user_sid("S-1-5-21--1001"));
        assert!(!is_valid_user_sid(""));
    }
}
