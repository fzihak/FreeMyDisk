use super::models::LeftoverConfidence;
use std::path::Path;

pub struct ConfidenceScorer;

impl ConfidenceScorer {
    /// Evaluates confidence score for a filesystem directory candidate
    pub fn score_filesystem(
        folder_name: &str,
        target_app: Option<&str>,
        publisher: Option<&str>,
        path: &Path,
    ) -> LeftoverConfidence {
        let folder_lower = folder_name.to_lowercase();
        let folder_clean = folder_lower.replace(['-', '_', ' ', '.'], "");

        if let Some(app) = target_app {
            let app_lower = app.to_lowercase();
            let app_clean = app_lower.replace(['-', '_', ' ', '.'], "");

            if !app_clean.is_empty() && folder_clean == app_clean {
                return LeftoverConfidence::High;
            }

            if app_clean.len() >= 3 && folder_clean.len() >= 3 {
                if folder_clean.starts_with(&app_clean) || app_clean.starts_with(&folder_clean) {
                    return LeftoverConfidence::High;
                }
                if folder_clean.contains(&app_clean) || app_clean.contains(&folder_clean) {
                    return LeftoverConfidence::Medium;
                }
            }
        }

        if let Some(pub_name) = publisher {
            let pub_lower = pub_name.to_lowercase();
            let pub_clean = pub_lower.replace(['-', '_', ' ', '.'], "");
            if !pub_clean.is_empty()
                && (folder_clean == pub_clean || folder_clean.contains(&pub_clean))
            {
                return LeftoverConfidence::Medium;
            }
        }

        let path_str = path.to_string_lossy().to_lowercase();
        if path_str.contains(r"\appdata\local\") || path_str.contains(r"\appdata\roaming\") {
            LeftoverConfidence::High
        } else if path_str.contains(r"\programdata\") {
            LeftoverConfidence::Medium
        } else {
            LeftoverConfidence::Low
        }
    }

    /// Evaluates confidence score for a registry key candidate
    pub fn score_registry(
        key_name: &str,
        target_app: Option<&str>,
        publisher: Option<&str>,
    ) -> LeftoverConfidence {
        let key_clean = key_name.to_lowercase().replace(['-', '_', ' ', '.'], "");

        if let Some(app) = target_app {
            let app_clean = app.to_lowercase().replace(['-', '_', ' ', '.'], "");
            if !app_clean.is_empty() && key_clean == app_clean {
                return LeftoverConfidence::High;
            }
            if app_clean.len() >= 3
                && (key_clean.contains(&app_clean) || app_clean.contains(&key_clean))
            {
                return LeftoverConfidence::Medium;
            }
        }

        if let Some(pub_name) = publisher {
            let pub_clean = pub_name.to_lowercase().replace(['-', '_', ' ', '.'], "");
            if !pub_clean.is_empty() && key_clean.contains(&pub_clean) {
                return LeftoverConfidence::Medium;
            }
        }

        LeftoverConfidence::Medium
    }
}
