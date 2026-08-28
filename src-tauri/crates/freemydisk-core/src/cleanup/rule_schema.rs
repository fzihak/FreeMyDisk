use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuleMetadata {
    pub id: String,
    pub name: String,
    pub category: String,
    pub risk: String,
    pub verified_rebuildable: bool,
    pub verified_at: String,
    pub author: String,
    pub description: String,
    pub platform: String,
    #[serde(default)]
    pub default_selected: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApplicabilityCondition {
    #[serde(rename = "type")]
    pub condition_type: String,
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Applicability {
    #[serde(default)]
    pub conditions: Vec<ApplicabilityCondition>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TargetPath {
    pub path: String,
    #[serde(default = "default_matcher")]
    pub matcher: String,
}

fn default_matcher() -> String {
    "glob".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Targets {
    #[serde(default)]
    pub paths: Vec<TargetPath>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DisposalConfig {
    #[serde(default = "default_action")]
    pub default_action: String,
    #[serde(default)]
    pub protect_subpaths: Vec<String>,
}

fn default_action() -> String {
    "trash".to_string()
}

impl Default for DisposalConfig {
    fn default() -> Self {
        Self {
            default_action: default_action(),
            protect_subpaths: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CleanupRuleDefinition {
    pub rule: RuleMetadata,
    #[serde(default)]
    pub applicability: Applicability,
    #[serde(default)]
    pub targets: Targets,
    #[serde(default)]
    pub disposal: DisposalConfig,
}
