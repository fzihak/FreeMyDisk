//! Read-only timing harness for the real machine. Run with
//! `cargo test -p freemydisk-core --test scan_timing_test -- --ignored --nocapture`.
//! Set `FMD_TIMING_ROOTS` (`;`-separated) to choose the Large Files / Duplicates roots.

use freemydisk_core::cleanup::rule_engine::RuleEngine;
use freemydisk_core::shared::progress::CancellationToken;
use freemydisk_core::storage::large_files::LargeFilesScanner;
use std::path::PathBuf;
use std::time::Instant;

fn timing_roots() -> Vec<PathBuf> {
    std::env::var("FMD_TIMING_ROOTS")
        .unwrap_or_else(|_| r"C:\".to_string())
        .split(';')
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .collect()
}

#[test]
#[ignore]
fn time_full_rule_scan() {
    let engine = RuleEngine::new();
    let cancel = CancellationToken::new();
    let start = Instant::now();
    let mut last = Instant::now();
    let mut slow = Vec::new();
    let mut order = Vec::new();
    let summaries = engine
        .scan_all_with_progress(&cancel, |name, done, _total, _bytes| {
            order.push(done);
            let gap = last.elapsed();
            if gap.as_millis() > 300 {
                slow.push(format!("{name}: {gap:?}"));
            }
            last = Instant::now();
        })
        .unwrap();
    let total: u64 = summaries.iter().map(|s| s.total_bytes).sum();
    let items: usize = summaries.iter().map(|s| s.total_items).sum();
    println!(
        "rules={} bytes={} items={} elapsed={:?}",
        summaries.len(),
        total,
        items,
        start.elapsed()
    );
    for s in &slow {
        println!("  slow gap before progress: {s}");
    }
    assert!(order.windows(2).all(|w| w[1] == w[0] + 1));
}

#[test]
#[ignore]
fn time_rule_scan_per_rule() {
    let engine = RuleEngine::new();
    let cancel = CancellationToken::new();
    let mut timings = Vec::new();
    for rule in engine.rules() {
        let start = Instant::now();
        let s = RuleEngine::scan_rule(rule, &cancel).unwrap();
        timings.push((start.elapsed(), rule.rule.name.clone(), s.total_bytes));
    }
    timings.sort_by_key(|t| std::cmp::Reverse(t.0));
    for (t, name, bytes) in timings.iter().take(12) {
        println!("{t:>12?}  {name}  ({bytes} bytes)");
    }
}

#[test]
#[ignore]
fn time_large_files_scan() {
    let cancel = CancellationToken::new();
    let roots = timing_roots();
    let start = Instant::now();
    let result = LargeFilesScanner::scan_large_files(&roots, 100 * 1024 * 1024, &cancel).unwrap();
    println!(
        "roots={:?} files={} bytes={} elapsed={:?}",
        roots,
        result.total_files,
        result.total_bytes,
        start.elapsed()
    );
    for f in result.files.iter().take(5) {
        println!("  {} {}", f.size_bytes, f.path.display());
    }
}

#[test]
#[ignore]
fn time_duplicates_scan() {
    use freemydisk_core::storage::duplicates::DuplicateDetector;
    let cancel = CancellationToken::new();
    let roots = timing_roots();
    let platform = freemydisk_platform::get_platform();
    let start = Instant::now();
    let result =
        DuplicateDetector::scan_duplicates(&roots, 10 * 1024 * 1024, &platform, &cancel).unwrap();
    println!(
        "roots={:?} groups={} dup_files={} savings={} elapsed={:?}",
        roots,
        result.total_groups,
        result.total_duplicate_files,
        result.total_potential_savings,
        start.elapsed()
    );
}

/// The walk used before pruning was added: every entry under the base folder up
/// to `max_depth`, matched with `glob_match`. Used to check the pruned walk finds
/// exactly the same paths on this machine.
fn reference_matching_paths(pattern: &str, protect: &[String]) -> Vec<(PathBuf, bool)> {
    use freemydisk_core::cleanup::matchers::{glob_match, is_subpath_protected};
    use freemydisk_core::cleanup::protected_paths::ProtectedPathRegistry;
    let expanded = freemydisk_core::shared::paths::expand_path_variables(pattern);
    let target_str = expanded.to_string_lossy().to_string();
    let mut found = Vec::new();
    let Some(first_star) = target_str.find('*') else {
        if expanded.exists()
            && !is_subpath_protected(&expanded, protect)
            && !ProtectedPathRegistry::is_protected_lexical(&expanded)
        {
            let is_dir = expanded.is_dir();
            found.push((expanded, is_dir));
        }
        return found;
    };
    let prefix = &target_str[..first_star];
    let base_dir = match prefix.rfind(['/', '\\']) {
        Some(idx) => PathBuf::from(&prefix[..idx]),
        None => PathBuf::from("."),
    };
    if !base_dir.exists() {
        return found;
    }
    let base_dir_str = base_dir.to_string_lossy();
    let rel_pattern = target_str.get(base_dir_str.len()..).unwrap_or("");
    let segment_count = rel_pattern
        .split(['/', '\\'])
        .filter(|s| !s.is_empty())
        .count();
    let max_depth = (segment_count + 3).clamp(4, 8);
    let dir_pattern = target_str
        .strip_suffix("/*")
        .or_else(|| target_str.strip_suffix(r"\*"));
    let mut matched_dirs: Vec<PathBuf> = Vec::new();
    for entry in walkdir::WalkDir::new(&base_dir)
        .min_depth(1)
        .max_depth(max_depth)
        .into_iter()
        .flatten()
    {
        let path = entry.path();
        if matched_dirs.iter().any(|d| path.starts_with(d)) {
            continue;
        }
        let is_dir = entry.file_type().is_dir();
        let path_str = path.to_string_lossy();
        let is_match = glob_match(&target_str, &path_str)
            || (is_dir
                && path != base_dir
                && dir_pattern.is_some_and(|p| glob_match(p, &path_str)));
        if !is_match
            || is_subpath_protected(path, protect)
            || ProtectedPathRegistry::is_protected_lexical(path)
        {
            continue;
        }
        if is_dir {
            matched_dirs.push(path.to_path_buf());
        }
        found.push((path.to_path_buf(), is_dir));
    }
    found
}

#[test]
#[ignore]
fn pruned_rule_walk_matches_reference_walk() {
    let engine = RuleEngine::new();
    let cancel = CancellationToken::new();
    let mut checked = 0usize;
    for rule in engine.rules() {
        if !RuleEngine::is_applicable(rule) || rule.targets.min_age_hours.is_some() {
            continue;
        }
        let mut expected: Vec<PathBuf> = rule
            .targets
            .paths
            .iter()
            .flat_map(|t| reference_matching_paths(&t.path, &rule.disposal.protect_subpaths))
            .map(|(p, _)| p)
            .collect();
        let mut actual: Vec<PathBuf> = RuleEngine::scan_rule(rule, &cancel)
            .unwrap()
            .all_candidates
            .into_iter()
            .map(|c| c.path)
            .collect();
        expected.sort();
        actual.sort();
        assert_eq!(actual, expected, "rule {}", rule.rule.id);
        checked += actual.len();
    }
    println!("matched paths identical; {checked} candidates compared");
}

#[test]
#[ignore]
fn print_lexical_protection_of_common_dirs() {
    use freemydisk_core::cleanup::protected_paths::ProtectedPathRegistry;
    let home = std::env::var("USERPROFILE").unwrap_or_default();
    for p in [
        "C:/Users".to_string(),
        home.clone(),
        format!("{home}/Downloads"),
        format!("{home}/AppData"),
        format!("{home}/AppData/Local"),
        "C:/ProgramData".to_string(),
        "D:/pagefile.sys".to_string(),
        "D:/System Volume Information".to_string(),
        "D:/Games".to_string(),
    ] {
        let pb = PathBuf::from(p.replace('/', std::path::MAIN_SEPARATOR_STR));
        println!(
            "{} -> {}",
            pb.display(),
            ProtectedPathRegistry::is_protected_lexical(&pb)
        );
    }
    let n = 20000;
    let p = PathBuf::from(format!("{home}/Documents/some/deep/file.bin"));
    let start = Instant::now();
    for _ in 0..n {
        std::hint::black_box(ProtectedPathRegistry::is_protected_lexical(&p));
    }
    println!("is_protected_lexical: {:?} per call", start.elapsed() / n);
}

/// The Large Files loop as shipped in 1.0.0: one serial Win32 walk per root with a
/// protected-path check on every entry. Kept to measure the old cost.
#[cfg(windows)]
#[test]
#[ignore]
fn time_large_files_legacy_walk() {
    use freemydisk_core::cleanup::protected_paths::ProtectedPathRegistry;
    let roots = timing_roots();
    let start = Instant::now();
    let mut entries = 0u64;
    let mut found = 0usize;
    for root in &roots {
        let mut cb = |p: &std::path::Path, _n: &str, size: u64, is_dir: bool| -> bool {
            entries += 1;
            if ProtectedPathRegistry::is_protected_lexical(p) {
                return false;
            }
            if !is_dir && size >= 100 * 1024 * 1024 {
                found += 1;
                let _ = p.metadata();
            }
            true
        };
        let _ = freemydisk_platform::windows::win32_fast_scan::win32_traverse_tree(
            root,
            &|| false,
            &mut cb,
        );
    }
    println!(
        "legacy roots={:?} entries={} files={} elapsed={:?}",
        roots,
        entries,
        found,
        start.elapsed()
    );
}
