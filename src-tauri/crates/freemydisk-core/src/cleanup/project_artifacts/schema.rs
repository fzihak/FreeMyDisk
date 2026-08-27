use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectRule {
    pub project: ProjectMeta,
    #[serde(default)]
    pub detection: Vec<DetectionRule>,
    #[serde(default)]
    pub artifacts: Vec<ArtifactRule>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectMeta {
    pub id: String,
    pub name: String,
    pub description: String,
    #[serde(default)]
    pub icon: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DetectionRule {
    #[serde(default)]
    pub marker_file: Option<String>,
    #[serde(default)]
    pub marker_dir: Option<String>,
    #[serde(default)]
    pub marker_extension: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArtifactRule {
    pub relative_path: String,
    #[serde(default = "default_category")]
    pub category: String,
    #[serde(default = "default_risk")]
    pub risk: String,
    #[serde(default = "default_rebuildable")]
    pub verified_rebuildable: bool,
    #[serde(default)]
    pub rebuild_command: Option<String>,
}

fn default_category() -> String {
    "build_output".to_string()
}

fn default_risk() -> String {
    "safe".to_string()
}

fn default_rebuildable() -> bool {
    true
}
