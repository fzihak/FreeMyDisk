use freemydisk_core::cleanup::project_artifacts::{
    ProjectArtifactScanner, ProjectCrawler, ProjectDetector,
};
use freemydisk_core::shared::progress::CancellationToken;
use std::fs::{self, File};
use std::io::Write;
use tempfile::TempDir;

#[test]
fn test_builtin_project_rules_load_and_validate() {
    let rules = ProjectDetector::get_rules();
    assert!(
        rules.len() >= 35,
        "Expected at least 35 builtin project rules, found {}",
        rules.len()
    );

    for rule in rules {
        assert!(!rule.project.id.is_empty(), "Project ID must not be empty");
        assert!(
            !rule.project.name.is_empty(),
            "Project name must not be empty"
        );
        assert!(
            !rule.artifacts.is_empty(),
            "Project must define at least one artifact rule"
        );
        assert!(
            !rule.detection.is_empty(),
            "Project must define at least one detection rule"
        );
    }
}

#[test]
fn test_project_detection_and_crawler() {
    let temp = TempDir::new().unwrap();
    let root = temp.path();

    // 1. Create a mock Node.js project:
    let node_proj = root.join("my-node-app");
    fs::create_dir_all(&node_proj).unwrap();
    File::create(node_proj.join("package.json"))
        .unwrap()
        .write_all(b"{\"name\": \"test\"}")
        .unwrap();

    let nm_dir = node_proj.join("node_modules").join("dummy-pkg");
    fs::create_dir_all(&nm_dir).unwrap();
    File::create(nm_dir.join("index.js"))
        .unwrap()
        .write_all(vec![0u8; 4096].as_slice())
        .unwrap();

    let next_dir = node_proj.join(".next");
    fs::create_dir_all(&next_dir).unwrap();
    File::create(next_dir.join("build-manifest.json"))
        .unwrap()
        .write_all(vec![0u8; 2048].as_slice())
        .unwrap();

    // 2. Create a mock Rust project:
    let rust_proj = root.join("my-rust-crate");
    fs::create_dir_all(&rust_proj).unwrap();
    File::create(rust_proj.join("Cargo.toml"))
        .unwrap()
        .write_all(b"[package]\nname=\"foo\"\n")
        .unwrap();

    let target_dir = rust_proj.join("target").join("debug");
    fs::create_dir_all(&target_dir).unwrap();
    File::create(target_dir.join("app.exe"))
        .unwrap()
        .write_all(vec![0u8; 8192].as_slice())
        .unwrap();

    // 3. Create a .git folder which should be strictly pruned:
    let git_dir = node_proj.join(".git").join("objects");
    fs::create_dir_all(&git_dir).unwrap();
    File::create(git_dir.join("pack.idx"))
        .unwrap()
        .write_all(vec![0u8; 1024].as_slice())
        .unwrap();

    let cancel = CancellationToken::new();
    let results = ProjectCrawler::crawl(&[root.to_path_buf()], 100, &cancel).unwrap();

    assert_eq!(results.len(), 2, "Expected 2 projects discovered");

    let node_match = results
        .iter()
        .find(|p| p.project_type == "project_node")
        .expect("Node project found");
    assert_eq!(node_match.project_name, "my-node-app");
    assert!(node_match
        .artifacts
        .iter()
        .any(|a| a.relative_path == "node_modules"));
    assert!(node_match
        .artifacts
        .iter()
        .any(|a| a.relative_path == ".next"));
    assert!(node_match.total_reclaimable_bytes >= 6144);

    let rust_match = results
        .iter()
        .find(|p| p.project_type == "project_rust")
        .expect("Rust project found");
    assert_eq!(rust_match.project_name, "my-rust-crate");
    assert!(rust_match
        .artifacts
        .iter()
        .any(|a| a.relative_path == "target"));
    assert!(rust_match.total_reclaimable_bytes >= 8192);

    // Test scanner orchestrator with sorting
    let scan_res = ProjectArtifactScanner::scan(&[root.to_path_buf()], Some(100), &cancel).unwrap();
    assert_eq!(scan_res.total_projects, 2);
    assert_eq!(scan_res.total_artifacts, 3);
    assert!(scan_res.total_reclaimable_bytes >= 14336);
}
