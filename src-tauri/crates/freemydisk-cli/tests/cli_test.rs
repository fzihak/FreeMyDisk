use std::process::Command;

fn get_cli_bin() -> std::path::PathBuf {
    let mut path = std::env::current_exe().expect("Failed to get current test exe path");
    path.pop();
    if path.ends_with("deps") {
        path.pop();
    }
    path.join("freemydisk-cli.exe")
}

#[test]
fn test_cli_help() {
    let bin = get_cli_bin();
    if !bin.exists() {
        eprintln!(
            "CLI binary not yet built at {}; skipping test",
            bin.display()
        );
        return;
    }

    let output = Command::new(&bin)
        .arg("--help")
        .output()
        .expect("Failed to execute freemydisk-cli --help");

    assert!(output.status.success());
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("scan"));
    assert!(stdout.contains("clean"));
    assert!(stdout.contains("duplicates"));
    assert!(stdout.contains("large-files"));
    assert!(stdout.contains("artifacts"));
    assert!(stdout.contains("analyze"));
    assert!(stdout.contains("maintenance"));
    assert!(stdout.contains("startup"));
    assert!(stdout.contains("apps"));
    assert!(stdout.contains("privacy"));
    assert!(stdout.contains("vitals"));
    assert!(stdout.contains("rescue"));
    assert!(stdout.contains("virtualization"));
}

#[test]
fn test_cli_artifacts_help() {
    let bin = get_cli_bin();
    if !bin.exists() {
        return;
    }

    let output = Command::new(&bin)
        .args(["artifacts", "--help"])
        .output()
        .expect("Failed to run artifacts --help");

    assert!(output.status.success());
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("--clean"));
    assert!(stdout.contains("--min-size"));
    assert!(stdout.contains("--inactive-days"));
}

#[test]
fn test_cli_privacy_help() {
    let bin = get_cli_bin();
    if !bin.exists() {
        return;
    }

    let output = Command::new(&bin)
        .args(["privacy", "--help"])
        .output()
        .expect("Failed to run privacy --help");

    assert!(output.status.success());
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("--clean"));
    assert!(stdout.contains("--clean-all"));
    assert!(stdout.contains("--close-browsers"));
    assert!(stdout.contains("--category"));
}

#[test]
fn test_cli_large_files_help() {
    let bin = get_cli_bin();
    if !bin.exists() {
        return;
    }

    let output = Command::new(&bin)
        .args(["large-files", "--help"])
        .output()
        .expect("Failed to run large-files --help");

    assert!(output.status.success());
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("--trash"));
    assert!(stdout.contains("--trash-all"));
}

#[test]
fn test_cli_duplicates_help() {
    let bin = get_cli_bin();
    if !bin.exists() {
        return;
    }

    let output = Command::new(&bin)
        .args(["duplicates", "--help"])
        .output()
        .expect("Failed to run duplicates --help");

    assert!(output.status.success());
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("--clean"));
    assert!(stdout.contains("--heuristic"));
}

#[test]
fn test_cli_apps_help() {
    let bin = get_cli_bin();
    if !bin.exists() {
        return;
    }

    let output = Command::new(&bin)
        .args(["apps", "--help"])
        .output()
        .expect("Failed to run apps --help");

    assert!(output.status.success());
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("--clean-leftovers"));
    assert!(stdout.contains("--leftovers"));
}

#[test]
fn test_cli_privacy_scan_json() {
    let bin = get_cli_bin();
    if !bin.exists() {
        return;
    }

    let output = Command::new(&bin)
        .args(["privacy", "--format", "json"])
        .output()
        .expect("Failed to run privacy --format json");

    assert!(output.status.success());
    let stdout = String::from_utf8_lossy(&output.stdout);
    let val: serde_json::Value = serde_json::from_str(&stdout).expect("Valid JSON expected");
    assert!(val.is_array());
}

#[test]
fn test_cli_maintenance_list_json() {
    let bin = get_cli_bin();
    if !bin.exists() {
        return;
    }

    let output = Command::new(&bin)
        .args(["maintenance", "--list", "--format", "json"])
        .output()
        .expect("Failed to run maintenance --list --format json");

    assert!(output.status.success());
    let stdout = String::from_utf8_lossy(&output.stdout);
    let val: serde_json::Value = serde_json::from_str(&stdout).expect("Valid JSON array expected");
    assert!(val.is_array());
    let tasks = val.as_array().unwrap();
    assert!(tasks.iter().any(|t| t["id"] == "icon_cache"));
    assert!(tasks.iter().any(|t| t["id"] == "dns_flush"));
}

#[test]
fn test_cli_startup_json() {
    let bin = get_cli_bin();
    if !bin.exists() {
        return;
    }

    let output = Command::new(&bin)
        .args(["startup", "--format", "json"])
        .output()
        .expect("Failed to run startup --format json");

    assert!(output.status.success());
    let stdout = String::from_utf8_lossy(&output.stdout);
    let val: serde_json::Value = serde_json::from_str(&stdout).expect("Valid JSON array expected");
    assert!(val.is_array());
}

#[test]
fn test_cli_clean_dry_run_json() {
    let bin = get_cli_bin();
    if !bin.exists() {
        return;
    }

    let output = Command::new(&bin)
        .args(["clean", "--dry-run", "--format", "json"])
        .output()
        .expect("Failed to run clean --dry-run --format json");

    assert!(output.status.success());
    let stdout = String::from_utf8_lossy(&output.stdout);
    let val: serde_json::Value = serde_json::from_str(&stdout).expect("Valid JSON expected");
    // Should be either [] if no candidates or a plan object
    assert!(val.is_object() || val.is_array());
}
