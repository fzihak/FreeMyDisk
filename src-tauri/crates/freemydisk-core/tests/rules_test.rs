use freemydisk_core::cleanup::matchers::is_subpath_protected;
use freemydisk_core::cleanup::rule_engine::RuleEngine;
use freemydisk_core::shared::paths::expand_path_variables;
use std::fs;
use tempfile::tempdir;

#[test]
fn test_builtin_rules_load_and_validate() {
    let engine = RuleEngine::new();
    assert!(
        engine.rules().len() >= 120,
        "Expected at least 120 built-in rules, found {}",
        engine.rules().len()
    );

    let has_temp = engine
        .rules()
        .iter()
        .any(|r| r.rule.id == "windows_system_temp");
    let has_chrome = engine
        .rules()
        .iter()
        .any(|r| r.rule.id == "windows_browser_chrome_cache");
    let has_cargo = engine
        .rules()
        .iter()
        .any(|r| r.rule.id == "windows_dev_cargo_cache");
    let has_teams = engine
        .rules()
        .iter()
        .any(|r| r.rule.id == "windows_app_teams_cache");
    let has_vivaldi = engine
        .rules()
        .iter()
        .any(|r| r.rule.id == "windows_browser_vivaldi_cache");
    let has_conda = engine
        .rules()
        .iter()
        .any(|r| r.rule.id == "windows_dev_conda_cache");
    let has_lmstudio = engine
        .rules()
        .iter()
        .any(|r| r.rule.id == "windows_ai_lmstudio_cache");
    let has_win_update = engine
        .rules()
        .iter()
        .any(|r| r.rule.id == "windows_system_update_download_cache");

    assert!(has_temp, "Missing windows_system_temp rule");
    assert!(has_chrome, "Missing windows_browser_chrome_cache rule");
    assert!(has_cargo, "Missing windows_dev_cargo_cache rule");
    assert!(has_teams, "Missing windows_app_teams_cache rule");
    assert!(has_vivaldi, "Missing windows_browser_vivaldi_cache rule");
    assert!(has_conda, "Missing windows_dev_conda_cache rule");
    assert!(has_lmstudio, "Missing windows_ai_lmstudio_cache rule");
    assert!(
        has_win_update,
        "Missing windows_system_update_download_cache rule"
    );
}

#[test]
fn test_path_variable_expansion() {
    let raw = "${home}/test_folder";
    let expanded = expand_path_variables(raw);
    assert!(
        !expanded.to_string_lossy().contains("${home}"),
        "Variable ${{home}} was not expanded"
    );
}

#[test]
fn test_rule_subpath_hard_filter_exclusion() {
    let temp = tempdir().unwrap();
    let cache_dir = temp.path().join("cache");
    fs::create_dir_all(&cache_dir).unwrap();

    let normal_file = cache_dir.join("data_001.bin");
    let cookie_file = cache_dir.join("cookies.sqlite");
    let history_file = cache_dir.join("history.db");

    fs::write(&normal_file, b"cache data").unwrap();
    fs::write(&cookie_file, b"sensitive cookie data").unwrap();
    fs::write(&history_file, b"sensitive browsing history").unwrap();

    let protect_patterns = vec!["*/cookies*".to_string(), "*/history*".to_string()];

    assert!(!is_subpath_protected(&normal_file, &protect_patterns));
    assert!(is_subpath_protected(&cookie_file, &protect_patterns));
    assert!(is_subpath_protected(&history_file, &protect_patterns));
}

#[test]
fn test_custom_rule_parsing() {
    let toml = r#"
[rule]
id = "custom_test_cache"
name = "Custom Test Cache"
category = "application"
risk = "safe"
verified_rebuildable = true
verified_at = "2026-08-15"
author = "Test Author"
description = "Test cache rule"
platform = "both"

[applicability]
conditions = []

[targets]
paths = [
    { path = "${temp}/custom_test/*", matcher = "glob" }
]

[disposal]
default_action = "permanent"
protect_subpaths = ["*/protected/*"]
"#;

    let rule = RuleEngine::parse_rule_toml(toml).expect("Custom rule should parse successfully");
    assert_eq!(rule.rule.id, "custom_test_cache");
    assert_eq!(rule.rule.risk, "safe");
    assert!(rule.rule.verified_rebuildable);
    assert_eq!(rule.disposal.protect_subpaths, vec!["*/protected/*"]);
}

#[test]
fn test_live_scan_rules() {
    use freemydisk_core::shared::progress::CancellationToken;
    let engine = RuleEngine::new();
    let cancel = CancellationToken::new();
    let summaries = engine.scan_all(&cancel).expect("Scan should succeed");
    let mut total_found = 0u64;
    let mut matching_rules = 0;
    println!(
        "\n=== LIVE SCAN RESULTS (Total rules: {}) ===",
        summaries.len()
    );
    for s in summaries {
        if s.total_bytes > 0 || s.total_items > 0 {
            matching_rules += 1;
            total_found += s.total_bytes;
            println!(
                "  Rule: {} ({}) => {} bytes, {} items, {} candidates",
                s.rule_name,
                s.rule_id,
                s.total_bytes,
                s.total_items,
                s.candidates.len()
            );
        }
    }
    println!(
        "Total rules with cleanable items: {} / {}, Total bytes: {} ({} MB)\n",
        matching_rules,
        engine.rules().len(),
        total_found,
        total_found / 1024 / 1024
    );
}

#[test]
fn test_live_candidates_and_plan() {
    use freemydisk_core::cleanup::plan::CleanupPlan;
    use freemydisk_core::shared::progress::CancellationToken;
    let engine = RuleEngine::new();
    let cancel = CancellationToken::new();
    let rule_ids = vec![
        "windows_browser_chrome_cache".to_string(),
        "windows_system_temp".to_string(),
    ];
    let candidates = engine
        .scan_all_candidates(&rule_ids, &cancel)
        .expect("Candidates scan failed");
    assert!(!candidates.is_empty(), "Candidates should not be empty");
    let candidate_count = candidates.len();
    println!(
        "\n=== CANDIDATES COUNT for Chrome & Temp: {} ===",
        candidate_count
    );
    let plan = CleanupPlan::from_candidates(candidates);
    println!(
        "=== PLAN ITEMS COUNT: {}, Total reclaimable: {} MB ===\n",
        plan.items.len(),
        plan.total_reclaimable_bytes / 1024 / 1024
    );
    for (i, item) in plan.items.iter().enumerate().take(15) {
        println!(
            "  Plan item {}: {} (is_dir: {}, size: {})",
            i,
            item.canonical_path.display(),
            item.is_dir,
            item.size_bytes
        );
    }
    assert!(
        plan.total_reclaimable_bytes > 0,
        "Reclaimable bytes should be > 0"
    );
}

#[test]
fn test_min_age_hours_skips_recently_modified_items() {
    use freemydisk_core::shared::progress::CancellationToken;
    use std::time::{Duration, SystemTime};

    let dir = tempdir().unwrap();
    let old_file = dir.path().join("old.tmp");
    let new_file = dir.path().join("new.tmp");
    fs::write(&old_file, b"old").unwrap();
    fs::write(&new_file, b"new").unwrap();
    fs::File::options()
        .write(true)
        .open(&old_file)
        .unwrap()
        .set_modified(SystemTime::now() - Duration::from_secs(3 * 3600))
        .unwrap();

    let pattern = format!("{}/*", dir.path().to_string_lossy().replace('\\', "/"));
    let toml = format!(
        r#"
[rule]
id = "test_min_age"
name = "Test"
category = "system"
risk = "safe"
verified_rebuildable = false
verified_at = "2026-11-26"
author = "test"
description = "test"
platform = "any"

[targets]
min_age_hours = 1
paths = [{{ path = "{}", matcher = "glob" }}]
"#,
        pattern
    );
    let rule = RuleEngine::parse_rule_toml(&toml).unwrap();
    let summary = RuleEngine::scan_rule(&rule, &CancellationToken::new()).unwrap();

    let paths: Vec<_> = summary
        .all_candidates
        .iter()
        .map(|c| c.path.clone())
        .collect();
    assert!(paths.contains(&old_file), "old file should be offered");
    assert!(!paths.contains(&new_file), "recent file must be kept");
}
