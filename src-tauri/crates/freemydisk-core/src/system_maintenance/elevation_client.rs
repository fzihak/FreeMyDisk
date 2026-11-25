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
    /// Locates freemydisk-elevated.exe next to the running app or in its bundled
    /// resources folder. Release builds look nowhere else, so a planted binary in the
    /// working directory or an environment variable can never be launched with the
    /// app's own elevation prompt. Debug builds also check the cargo target folders.
    pub fn find_helper_executable() -> Option<PathBuf> {
        const HELPER: &str = "freemydisk-elevated.exe";

        if let Some(dir) = std::env::current_exe()
            .ok()
            .and_then(|e| e.parent().map(PathBuf::from))
        {
            for candidate in [dir.join(HELPER), dir.join("resources").join(HELPER)] {
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }

        #[cfg(debug_assertions)]
        {
            let dev_candidates = [
                "src-tauri/resources",
                "resources",
                "../resources",
                "target/debug",
                "../target/debug",
                "../../target/debug",
                "target/release",
                "../target/release",
            ];
            for dir in dev_candidates {
                let candidate = PathBuf::from(dir).join(HELPER);
                if candidate.is_file() {
                    return Some(dunce::canonicalize(&candidate).unwrap_or(candidate));
                }
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

        // Unelevated: request elevation with Start-Process -Verb RunAs. The request is
        // passed on the helper's command line (hex encoded), which other processes
        // cannot change once the elevated helper has started, unlike a file in %TEMP%.
        let token = session_token;
        let resp_file = std::env::temp_dir().join(format!("fmd_elev_resp_{}.json", token));
        let request_hex: String = serde_json::to_vec(&req)?
            .iter()
            .map(|b| format!("{:02x}", b))
            .collect();

        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            let helper_str = helper_path.to_string_lossy().replace('\'', "''");
            let resp_str = resp_file.to_string_lossy().replace('\'', "''");

            let ps_args = format!(
                "Start-Process -FilePath '{}' -ArgumentList '--token \"{}\" --request-hex {} --response \"{}\"' -Verb RunAs -WindowStyle Hidden -Wait",
                helper_str, token, request_hex, resp_str
            );

            let mut cmd = Command::new("powershell");
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
            cmd.args(["-NoProfile", "-NonInteractive", "-Command", &ps_args]);

            let status = cmd.status()?;

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
            let _ = (&request_hex, &helper_path);
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
