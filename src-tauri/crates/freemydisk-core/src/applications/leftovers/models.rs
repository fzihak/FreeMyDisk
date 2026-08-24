use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LeftoverConfidence {
    Low,
    Medium,
    High,
}

impl std::fmt::Display for LeftoverConfidence {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Low => write!(f, "Low"),
            Self::Medium => write!(f, "Medium"),
            Self::High => write!(f, "High"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LeftoverKind {
    Filesystem,
    Registry,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LeftoverCandidate {
    pub id: String,
    pub path_or_key: String,
    pub kind: LeftoverKind,
    pub size_bytes: u64,
    pub item_count: u64,
    pub confidence: LeftoverConfidence,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LeftoverGroup {
    pub id: String,
    pub app_name: String,
    pub publisher: Option<String>,
    pub items: Vec<LeftoverCandidate>,
    pub total_size_bytes: u64,
    pub overall_confidence: LeftoverConfidence,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApplicationLeftover {
    pub id: String,
    pub app_name: String,
    pub path: String,
    pub size_bytes: u64,
    pub item_count: u64,
    pub category: String,
    pub confidence: String,
}
