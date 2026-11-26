use freemydisk_core::applications::leftovers::confidence::ConfidenceScorer;
use freemydisk_core::applications::leftovers::models::LeftoverConfidence;
use freemydisk_core::applications::process_control::ProcessController;
use freemydisk_core::applications::ApplicationService;
use std::path::Path;

#[test]
fn test_confidence_scorer() {
    // Exact match
    let score = ConfidenceScorer::score_filesystem(
        "Discord",
        Some("Discord"),
        None,
        Path::new(r"C:\Users\User\AppData\Local\Discord"),
    );
    assert_eq!(score, LeftoverConfidence::High);

    // Partial match
    let score = ConfidenceScorer::score_filesystem(
        "DiscordCanary",
        Some("Discord"),
        None,
        Path::new(r"C:\Users\User\AppData\Local\DiscordCanary"),
    );
    assert_eq!(score, LeftoverConfidence::High);

    // Registry score
    let reg_score = ConfidenceScorer::score_registry("Spotify", Some("Spotify"), None);
    assert_eq!(reg_score, LeftoverConfidence::High);
}

#[test]
// Process and installed-app discovery are implemented on Windows only.
#[cfg_attr(not(target_os = "windows"), ignore = "Windows-only backend")]
fn test_process_controller_current_process() {
    let current_pid = std::process::id();
    assert!(ProcessController::is_process_alive(current_pid));
    assert!(!ProcessController::is_process_alive(999_999_999));
}

#[test]
// Process and installed-app discovery are implemented on Windows only.
#[cfg_attr(not(target_os = "windows"), ignore = "Windows-only backend")]
fn test_application_service_discovery() {
    let service = ApplicationService::new();
    let apps = service.list_applications().unwrap();
    // Host Windows machine should list installed applications
    println!("Discovered {} installed applications on system", apps.len());
    assert!(
        !apps.is_empty(),
        "Should discover installed applications on Windows host"
    );

    // Scan deep leftovers
    let deep = service.scan_deep_leftovers().unwrap();
    println!("Discovered {} leftover groups", deep.len());
}

#[test]
fn test_app_processes_are_matched_by_install_folder() {
    use freemydisk_core::applications::process_control::{app_folders, runs_from};
    use freemydisk_platform::RawRunningProcess;

    let dir = tempfile::tempdir().unwrap();
    let install = dir.path().join("Vendor").join("Editor");
    std::fs::create_dir_all(&install).unwrap();

    let dirs = app_folders(Some(install.to_str().unwrap()), None);
    assert_eq!(dirs.len(), 1);

    let proc = |exe: &str| RawRunningProcess {
        pid: 1,
        name: "x.exe".to_string(),
        exe_path: Some(exe.to_string()),
    };
    // Compare against the canonical folder: temp paths on CI runners can use
    // 8.3 short names (RUNNER~1) that canonicalisation expands.
    let install = dirs[0].clone();
    let inside = install.join("bin").join("editor.exe");
    assert!(runs_from(
        &proc(&inside.to_string_lossy().to_uppercase()),
        &dirs
    ));
    let sibling = format!("{}-helper\\other.exe", install.to_string_lossy());
    assert!(
        !runs_from(&proc(&sibling), &dirs),
        "prefix of another folder must not match"
    );
    assert!(!runs_from(
        &RawRunningProcess {
            pid: 2,
            name: "editor.exe".to_string(),
            exe_path: None
        },
        &dirs
    ));

    // Shared and system folders never identify an app.
    if let Ok(pf) = std::env::var("ProgramFiles") {
        assert!(app_folders(Some(&pf), None).is_empty());
    }
    if let Ok(win) = std::env::var("SystemRoot") {
        assert!(app_folders(None, Some(&format!(r"{}\System32\msiexec.exe,0", win))).is_empty());
    }
}
