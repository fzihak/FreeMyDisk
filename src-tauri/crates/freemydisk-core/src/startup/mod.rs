use freemydisk_platform::{get_platform, PlatformStartup, RawStartupEntry};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StartupImpact {
    Low,
    Medium,
    High,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StartupItem {
    pub id: String,
    pub name: String,
    pub command: String,
    pub location: String,
    pub enabled: bool,
    pub impact: StartupImpact,
    pub is_critical: bool,
    pub target_path: Option<String>,
}

pub struct StartupService {
    platform: Box<dyn PlatformStartup>,
}

impl StartupService {
    pub fn new() -> Self {
        Self {
            platform: Box::new(get_platform()),
        }
    }

    pub fn with_platform(platform: Box<dyn PlatformStartup>) -> Self {
        Self { platform }
    }

    pub fn list_startup_items(&self) -> Result<Vec<StartupItem>, String> {
        let raw = self
            .platform
            .list_startup_entries()
            .map_err(|e| e.to_string())?;

        let items = raw
            .into_iter()
            .map(|entry| {
                let impact = Self::calculate_impact(&entry);
                let is_critical = Self::is_critical_item(&entry);
                StartupItem {
                    id: entry.id,
                    name: entry.name,
                    command: entry.command,
                    location: entry.location,
                    enabled: entry.enabled,
                    impact,
                    is_critical,
                    target_path: entry.target_path,
                }
            })
            .collect();

        Ok(items)
    }

    pub fn toggle_startup_item(&self, item_id: &str, enable: bool) -> Result<(), String> {
        // Enforce safety invariant: critical system items cannot be disabled
        if !enable {
            let items = self.list_startup_items()?;
            if let Some(target) = items.iter().find(|i| i.id == item_id) {
                if target.is_critical {
                    return Err(format!(
                        "Refusing to disable critical system startup entry: '{}'",
                        target.name
                    ));
                }
            }
        }

        match self.platform.set_startup_entry_state(item_id, enable) {
            Ok(()) => Ok(()),
            Err(e) => {
                if matches!(
                    e,
                    freemydisk_platform::traits::PlatformError::ElevationRequired(_)
                ) || item_id.starts_with("hklm:run:")
                {
                    let payload = serde_json::json!({
                        "entry_id": item_id,
                        "enable": enable,
                    })
                    .to_string();
                    match crate::system_maintenance::ElevatedClient::execute_action(
                        "toggle_hklm_startup",
                        &payload,
                    ) {
                        Ok(resp) if resp.success => Ok(()),
                        Ok(resp) => Err(resp.message),
                        Err(err) => Err(err.to_string()),
                    }
                } else {
                    Err(e.to_string())
                }
            }
        }
    }

    pub fn delete_startup_item(&self, item_id: &str) -> Result<(), String> {
        let items = self.list_startup_items()?;
        if let Some(target) = items.iter().find(|i| i.id == item_id) {
            if target.is_critical {
                return Err(format!(
                    "Refusing to delete critical system startup entry: '{}'",
                    target.name
                ));
            }
        }

        match self.platform.delete_startup_entry(item_id) {
            Ok(()) => Ok(()),
            Err(e) => {
                if matches!(
                    e,
                    freemydisk_platform::traits::PlatformError::ElevationRequired(_)
                ) || item_id.starts_with("hklm:run:")
                {
                    let payload = serde_json::json!({
                        "entry_id": item_id,
                    })
                    .to_string();
                    match crate::system_maintenance::ElevatedClient::execute_action(
                        "delete_hklm_startup",
                        &payload,
                    ) {
                        Ok(resp) if resp.success => Ok(()),
                        Ok(resp) => Err(resp.message),
                        Err(err) => Err(err.to_string()),
                    }
                } else {
                    Err(e.to_string())
                }
            }
        }
    }

    fn calculate_impact(entry: &RawStartupEntry) -> StartupImpact {
        let lower = entry.command.to_lowercase();
        let name_lower = entry.name.to_lowercase();

        // High impact apps (games, heavy background engines, browsers)
        if lower.contains("steam")
            || lower.contains("discord")
            || lower.contains("spotify")
            || lower.contains("teams")
            || lower.contains("slack")
            || lower.contains("epicgames")
            || lower.contains("chrome")
            || lower.contains("edge")
        {
            StartupImpact::High
        } else if lower.contains("update")
            || lower.contains("helper")
            || lower.contains("tray")
            || name_lower.contains("sync")
            || name_lower.contains("cloud")
        {
            StartupImpact::Medium
        } else {
            StartupImpact::Low
        }
    }

    fn is_critical_item(entry: &RawStartupEntry) -> bool {
        let lower = entry.command.to_lowercase();
        let name_lower = entry.name.to_lowercase();

        lower.contains("securityhealth")
            || lower.contains("windows defender")
            || lower.contains("antivirus")
            || lower.contains("windefend")
            || name_lower.contains("securityhealth")
            || name_lower.contains("windows defender")
    }
}

impl Default for StartupService {
    fn default() -> Self {
        Self::new()
    }
}
