use crate::shared::errors::CoreError;
use freemydisk_platform::get_platform;
use freemydisk_platform::traits::PlatformElevation;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::Command;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ElevatedRequest {
    pub operation: String,
    pub payload: String,
    #[serde(default)]
    pub token: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ElevatedResponse {
    pub success: bool,
    pub message: String,
}

pub struct ElevatedClient;

impl ElevatedClient {
    /// Discovers the path to the freemydisk-elevated executable
    pub fn find_helper_executable() -> Option<PathBuf> {
        // 0. Explicit environment variable override (for automation, CI, and custom installations)
        if let Ok(custom_path) = std::env::var("FREEMYDISK_HELPER_PATH") {
            let p = PathBuf::from(custom_path);
            if p.exists() {
                return Some(dunce::canonicalize(&p).unwrap_or(p));
            }
        }

        // 1. Same directory as current executable or bundled resources folder (Production NSIS)
        if let Ok(cur_exe) = std::env::current_exe() {
            if let Some(parent) = cur_exe.parent() {
                let candidate = parent.join("freemydisk-elevated.exe");
                if candidate.exists() {
                    return Some(candidate);
                }
                let resource_candidate = parent.join("resources").join("freemydisk-elevated.exe");
                if resource_candidate.exists() {
                    return Some(resource_candidate);
                }
            }
        }

        // 2. Relative cargo target and dev resources directories for dev/testing
        let dev_candidates = [
            PathBuf::from("src-tauri/resources/freemydisk-elevated.exe"),
            PathBuf::from("resources/freemydisk-elevated.exe"),
            PathBuf::from("../resources/freemydisk-elevated.exe"),
            PathBuf::from("target/release/freemydisk-elevated.exe"),
            PathBuf::from("target/debug/freemydisk-elevated.exe"),
            PathBuf::from("../target/release/freemydisk-elevated.exe"),
            PathBuf::from("../target/debug/freemydisk-elevated.exe"),
            PathBuf::from("../../target/release/freemydisk-elevated.exe"),
            PathBuf::from("../../target/debug/freemydisk-elevated.exe"),
            PathBuf::from("src-tauri/target/release/freemydisk-elevated.exe"),
            PathBuf::from("src-tauri/target/debug/freemydisk-elevated.exe"),
            PathBuf::from("helpers/freemydisk-elevated/target/release/freemydisk-elevated.exe"),
            PathBuf::from("helpers/freemydisk-elevated/target/debug/freemydisk-elevated.exe"),
        ];

        for c in &dev_candidates {
            if c.exists() {
                return Some(dunce::canonicalize(c).unwrap_or_else(|_| c.clone()));
            }
        }

        None
    }

    /// Executes an allowlisted action through the elevated helper.
    /// If the current process is already running as Administrator, invokes the helper via direct stdin pipe.
    /// If unelevated, invokes with UAC prompt (RunAs) passing serialized files with cryptographic session token.
    pub fn execute_action(operation: &str, payload: &str) -> Result<ElevatedResponse, CoreError> {
        let helper_path = Self::find_helper_executable().ok_or_else(|| {
            CoreError::Platform(freemydisk_platform::traits::PlatformError::OperationFailed(
                "freemydisk-elevated helper executable not found".to_string(),
            ))
        })?;

        let platform = get_platform();
        let is_admin = platform.is_elevated();
        let session_token = Uuid::new_v4().to_string();

        let req = ElevatedRequest {
            operation: operation.to_string(),
            payload: payload.to_string(),
            token: Some(session_token.clone()),
        };

        if is_admin {
            // Already elevated: direct stdin execution
            let req_json = serde_json::to_string(&req)?;
            let mut cmd = Command::new(&helper_path);
            #[cfg(target_os = "windows")]
            {
                use std::os::windows::process::CommandExt;
                cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
            }
            cmd.arg("--token").arg(&session_token);
            cmd.stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped());

            let mut child = cmd.spawn()?;
            if let Some(mut stdin) = child.stdin.take() {
                use std::io::Write;
                stdin.write_all(req_json.as_bytes())?;
            }

            let output = child.wait_with_output()?;
            let resp_str = String::from_utf8_lossy(&output.stdout);
            let resp = serde_json::from_str::<ElevatedResponse>(&resp_str).unwrap_or_else(|_| {
                ElevatedResponse {
                    success: output.status.success(),
                    message: resp_str.to_string(),
                }
            });
            return Ok(resp);
        }

        // Unelevated: Request elevation via PowerShell Start-Process -Verb RunAs with temporary token files
        let token = session_token;
        let temp_dir = std::env::temp_dir();
        let req_file = temp_dir.join(format!("fmd_elev_req_{}.json", token));
        let resp_file = temp_dir.join(format!("fmd_elev_resp_{}.json", token));

        serde_json::to_writer(std::fs::File::create(&req_file)?, &req)?;

        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            let helper_str = helper_path.to_string_lossy().replace('\'', "''");
            let req_str = req_file.to_string_lossy().replace('\'', "''");
            let resp_str = resp_file.to_string_lossy().replace('\'', "''");

            let ps_args = format!(
                "Start-Process -FilePath '{}' -ArgumentList '--token \"{}\" --file \"{}\" \"{}\"' -Verb RunAs -WindowStyle Hidden -Wait",
                helper_str, token, req_str, resp_str
            );

            let mut cmd = Command::new("powershell");
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
            cmd.args(["-NoProfile", "-NonInteractive", "-Command", &ps_args]);

            let status = cmd.status()?;
            let _ = std::fs::remove_file(&req_file);

            if !status.success() {
                let _ = std::fs::remove_file(&resp_file);
                return Err(CoreError::Platform(
                    freemydisk_platform::traits::PlatformError::ElevationRequired(
                        "UAC elevation was denied or cancelled by user".to_string(),
                    ),
                ));
            }
        }

        #[cfg(not(target_os = "windows"))]
        {
            let _ = std::fs::remove_file(&req_file);
            let _ = std::fs::remove_file(&resp_file);
            return Err(CoreError::Platform(
                freemydisk_platform::traits::PlatformError::Unsupported(
                    "Elevation helper only supported on Windows".to_string(),
                ),
            ));
        }

        if !resp_file.exists() {
            return Err(CoreError::Platform(
                freemydisk_platform::traits::PlatformError::OperationFailed(
                    "Elevated helper did not produce a response file".to_string(),
                ),
            ));
        }

        let resp_content = std::fs::read_to_string(&resp_file)?;
        let _ = std::fs::remove_file(&resp_file);

        let resp: ElevatedResponse = serde_json::from_str(&resp_content)
            .map_err(|e| CoreError::Validation(format!("Invalid response from helper: {}", e)))?;

        Ok(resp)
    }
}
