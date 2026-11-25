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
fn test_process_controller_current_process() {
    let current_pid = std::process::id();
    assert!(ProcessController::is_process_alive(current_pid));
    assert!(!ProcessController::is_process_alive(999_999_999));
}

#[test]
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
