use crate::cleanup::rule_engine::RuleScanCandidate;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CleanupPlanItem {
    pub original_path: PathBuf,
    pub canonical_path: PathBuf,
    pub size_bytes: u64,
    pub is_dir: bool,
    pub matched_rules: Vec<String>,
    pub default_action: String,
    pub verified_rebuildable: bool,
    pub protect_subpaths: Vec<String>,
    pub risk: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CleanupPlan {
    pub items: Vec<CleanupPlanItem>,
    pub total_reclaimable_bytes: u64,
    pub total_items: usize,
}

impl CleanupPlan {
    /// Creates a deduplicated cleanup plan from raw rule scan candidates.
    /// Deduplicates by canonical absolute path to guarantee zero double-counting
    /// and zero redundant deletion attempts.
    pub fn from_candidates(candidates: Vec<RuleScanCandidate>) -> Self {
        let mut map: HashMap<PathBuf, CleanupPlanItem> = HashMap::new();

        for candidate in candidates {
            let canon = dunce::canonicalize(&candidate.path)
                .unwrap_or_else(|_| dunce::simplified(&candidate.path).to_path_buf());

            if let Some(existing) = map.get_mut(&canon) {
                // Path matched by multiple rules! Merge with strictest safety attributes
                if !existing.matched_rules.contains(&candidate.rule_id) {
                    existing.matched_rules.push(candidate.rule_id);
                }

                // Strictest action: If ANY rule specifies trash, enforce trash
                if candidate.default_action == "trash" {
                    existing.default_action = "trash".to_string();
                }

                // Strictest rebuildable: Must be true in ALL rules to stay true
                if !candidate.verified_rebuildable {
                    existing.verified_rebuildable = false;
                }

                // Strictest risk: escalate if needed
                if candidate.risk == "dangerous" || existing.risk == "dangerous" {
                    existing.risk = "dangerous".to_string();
                } else if candidate.risk == "caution" || existing.risk == "caution" {
                    existing.risk = "caution".to_string();
                }

                // Union of protected subpaths
                for pat in candidate.protect_subpaths {
                    if !existing.protect_subpaths.contains(&pat) {
                        existing.protect_subpaths.push(pat);
                    }
                }
            } else {
                map.insert(
                    canon.clone(),
                    CleanupPlanItem {
                        original_path: candidate.path,
                        canonical_path: canon,
                        size_bytes: candidate.size_bytes,
                        is_dir: candidate.is_dir,
                        matched_rules: vec![candidate.rule_id],
                        default_action: candidate.default_action,
                        verified_rebuildable: candidate.verified_rebuildable,
                        protect_subpaths: candidate.protect_subpaths,
                        risk: candidate.risk,
                    },
                );
            }
        }

        let mut items: Vec<CleanupPlanItem> = map.into_values().collect();
        // Stable sort by canonical path for deterministic plan execution
        items.sort_by(|a, b| a.canonical_path.cmp(&b.canonical_path));

        let total_reclaimable_bytes = items.iter().map(|i| i.size_bytes).sum();
        let total_items = items.len();

        Self {
            items,
            total_reclaimable_bytes,
            total_items,
        }
    }
}
