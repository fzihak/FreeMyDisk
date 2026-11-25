use freemydisk_core::cleanup::plan::CleanupPlan;
use freemydisk_core::cleanup::rule_engine::RuleScanCandidate;
use std::fs;
use tempfile::tempdir;

#[test]
fn test_plan_canonical_deduplication_eliminates_double_counting() {
    let temp = tempdir().unwrap();
    let file_path = temp.path().join("shared_cache.tmp");
    fs::write(&file_path, vec![0u8; 1024 * 1024]).unwrap(); // 1MB file

    let candidate_rule1 = RuleScanCandidate {
        path: file_path.clone(),
        size_bytes: 1024 * 1024,
        is_dir: false,
        rule_id: "rule_system_temp".to_string(),
        rule_name: "System Temp".to_string(),
        category: "system".to_string(),
        risk: "safe".to_string(),
        verified_rebuildable: true,
        default_action: "permanent".to_string(),
        protect_subpaths: vec!["*/safe/*".to_string()],
    };

    let candidate_rule2 = RuleScanCandidate {
        path: file_path.clone(),
        size_bytes: 1024 * 1024,
        is_dir: false,
        rule_id: "rule_generic_cache".to_string(),
        rule_name: "Generic Cache".to_string(),
        category: "cache".to_string(),
        risk: "caution".to_string(),
        verified_rebuildable: false,         // Rule 2 is NOT rebuildable
        default_action: "trash".to_string(), // Rule 2 requests TRASH
        protect_subpaths: vec!["*/data/*".to_string()],
    };

    let plan = CleanupPlan::from_candidates(vec![candidate_rule1, candidate_rule2]);

    // Invariant 1: Exactly 1 item after canonical deduplication
    assert_eq!(
        plan.items.len(),
        1,
        "Expected 1 deduplicated item, found {}",
        plan.items.len()
    );
    let item = &plan.items[0];

    // Invariant 2: Size counted exactly once (1MB, not 2MB)
    assert_eq!(item.size_bytes, 1024 * 1024);
    assert_eq!(plan.total_reclaimable_bytes, 1024 * 1024);

    // Invariant 3: Matched rules tracks both rules
    assert_eq!(item.matched_rules.len(), 2);
    assert!(item.matched_rules.contains(&"rule_system_temp".to_string()));
    assert!(item
        .matched_rules
        .contains(&"rule_generic_cache".to_string()));

    // Invariant 4: Strictest safety attributes enforced
    assert_eq!(
        item.default_action, "trash",
        "Strictest default action should be trash"
    );
    assert!(
        !item.verified_rebuildable,
        "Strictest verified_rebuildable must be false if any rule says false"
    );
    assert_eq!(
        item.risk, "caution",
        "Strictest risk must escalate to caution"
    );
    assert_eq!(item.protect_subpaths.len(), 2);
}
