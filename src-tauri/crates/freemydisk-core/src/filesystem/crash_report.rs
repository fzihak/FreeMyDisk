use crate::shared::errors::CoreError;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CrashDumpReport {
    pub timestamp: u64,
    pub panic_message: String,
    pub location: String,
    pub backtrace: String,
    pub os_version: String,
    pub app_version: String,
}

impl CrashDumpReport {
    pub fn new(panic_message: String, location: String, backtrace: String) -> Self {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);

        let os_version = std::env::consts::OS.to_string();
        let app_version = env!("CARGO_PKG_VERSION").to_string();

        Self {
            timestamp,
            panic_message,
            location,
            backtrace,
            os_version,
            app_version,
        }
    }

    /// Determines the standard crash reports directory in %LOCALAPPDATA%\FreeMyDisk\crash_reports
    pub fn get_crash_reports_dir() -> PathBuf {
        if let Ok(local_app) = std::env::var("LOCALAPPDATA") {
            PathBuf::from(local_app)
                .join("FreeMyDisk")
                .join("crash_reports")
        } else {
            std::env::temp_dir()
                .join("FreeMyDisk")
                .join("crash_reports")
        }
    }

    /// Saves the symbolicated crash dump report JSON to disk.
    pub fn save_to_disk(&self) -> Result<PathBuf, CoreError> {
        let dir = Self::get_crash_reports_dir();
        fs::create_dir_all(&dir)?;

        let filename = format!("panic_{}.json", self.timestamp);
        let path = dir.join(filename);
        let json = serde_json::to_string_pretty(self)?;
        fs::write(&path, json)?;
        Ok(path)
    }

    /// Enumerates existing crash dump reports from disk.
    pub fn list_reports() -> Result<Vec<Self>, CoreError> {
        let dir = Self::get_crash_reports_dir();
        if !dir.exists() {
            return Ok(Vec::new());
        }

        let mut reports = Vec::new();
        if let Ok(entries) = fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let p = entry.path();
                if p.extension().map(|e| e == "json").unwrap_or(false) {
                    if let Ok(content) = fs::read_to_string(&p) {
                        if let Ok(report) = serde_json::from_str::<Self>(&content) {
                            reports.push(report);
                        }
                    }
                }
            }
        }

        reports.sort_by_key(|a| std::cmp::Reverse(a.timestamp));
        Ok(reports)
    }
}

/// Redacts personal and sensitive information from diagnostic texts:
/// - Windows usernames in C:\Users\{username}\ replaced with {USER}
/// - Authentication tokens, passwords, and API keys scrubbed
/// - Hostnames anonymized
pub fn sanitize_diagnostic_text(raw: &str) -> String {
    let mut sanitized = raw.to_string();

    // 1. Redact username from file paths
    if let Ok(user) = std::env::var("USERNAME") {
        if !user.is_empty() {
            sanitized = sanitized.replace(&user, "{USER}");
        }
    }

    // 2. Redact USERPROFILE path
    if let Ok(user_profile) = std::env::var("USERPROFILE") {
        if !user_profile.is_empty() {
            sanitized = sanitized.replace(&user_profile, r"C:\Users\{USER}");
        }
    }

    // 3. Redact Computer Hostname
    if let Ok(computer_name) = std::env::var("COMPUTERNAME") {
        if !computer_name.is_empty() {
            sanitized = sanitized.replace(&computer_name, "{HOST}");
        }
    }

    // 4. Scrub common bearer tokens and keys
    for secret_marker in &["sk-proj-", "ghp_", "bearer ", "password=", "secret="] {
        if let Some(idx) = sanitized.to_lowercase().find(secret_marker) {
            let end_idx = sanitized[idx..]
                .find(|c: char| c.is_whitespace() || c == '"' || c == '\n')
                .map(|offset| idx + offset)
                .unwrap_or(sanitized.len());
            sanitized.replace_range(idx..end_idx, "[REDACTED_SECRET]");
        }
    }

    sanitized
}
