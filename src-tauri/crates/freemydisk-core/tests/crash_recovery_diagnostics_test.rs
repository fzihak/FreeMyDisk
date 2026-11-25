use freemydisk_core::filesystem::crash_report::{sanitize_diagnostic_text, CrashDumpReport};
use freemydisk_core::filesystem::journal::{CrashRecoveryJournal, RemediationOutcome};
use freemydisk_core::shared::errors::CoreError;
use std::fs;
use tempfile::tempdir;

#[test]
fn test_crash_dump_report_and_privacy_sanitization() {
    let raw_backtrace = "stack backtrace:\n   0: std::panicking::begin_panic\n   1: C:\\Users\\Administrator\\AppData\\Local\\Temp\\panic.rs:42";
    let report = CrashDumpReport::new(
        "simulated critical error".to_string(),
        "src/test.rs:10:5".to_string(),
        raw_backtrace.to_string(),
    );

    assert_eq!(report.panic_message, "simulated critical error");
    assert_eq!(report.app_version, env!("CARGO_PKG_VERSION"));
    assert!(report.timestamp > 0);

    // Test privacy sanitization filter
    let raw_log = "Error occurred for user C:\\Users\\Administrator\\Projects\\SecretRepo with token sk-proj-1234567890abcdef and computer name WORKSTATION-01";
    let sanitized = sanitize_diagnostic_text(raw_log);

    assert!(
        !sanitized.contains("sk-proj-1234567890abcdef"),
        "Secrets must be redacted"
    );
    assert!(
        sanitized.contains("[REDACTED_SECRET]"),
        "Redaction marker must be present"
    );
}

#[test]
fn test_sqlite_journal_integrity_and_emergency_flush() {
    let dir = tempdir().expect("tempdir failed");
    let db_path = dir.path().join("test_journal.db");

    let journal = CrashRecoveryJournal::open(&db_path).expect("open journal failed");

    // PRAGMA integrity_check
    let integrity = journal.check_integrity().expect("integrity check failed");
    assert_eq!(
        integrity, "ok",
        "Database file must pass SQLite integrity check"
    );

    // Emergency WAL flush checkpoint
    assert!(
        journal.emergency_flush().is_ok(),
        "Emergency flush must succeed"
    );
}

#[test]
fn test_two_phase_atomic_crash_recovery_self_healing_on_boot() {
    let dir = tempdir().expect("tempdir failed");
    let db_path = dir.path().join("journal.db");
    let journal = CrashRecoveryJournal::open(&db_path).expect("open failed");

    // Step 1: Clean startup verification
    let initial_status = journal.inspect_dirty_shutdown().expect("inspect failed");
    assert!(!initial_status.has_interrupted);
    assert_eq!(initial_status.interrupted_count, 0);

    // Step 2: Simulate in-flight staged operation interrupted by application crash
    let original_target = dir.path().join("user_document.txt");
    let staging_path = dir.path().join(".fmd-staging-abc123");

    // Create the staged file (original was moved here before crash)
    fs::write(&staging_path, b"IMPORTANT RESTORABLE USER DATA").expect("write failed");
    assert!(staging_path.exists());
    assert!(!original_target.exists());

    // Record uncommitted intent
    let _row_id = journal
        .write_intent(
            "session-crash-sim",
            &original_target,
            Some(&staging_path),
            "permanent",
        )
        .expect("write intent failed");

    // Step 3: Inspect dirty shutdown
    let dirty_status = journal
        .inspect_dirty_shutdown()
        .expect("inspect dirty failed");
    assert!(
        dirty_status.has_interrupted,
        "Must detect in-flight crash records"
    );
    assert_eq!(dirty_status.interrupted_count, 1);
    assert!(
        dirty_status.can_auto_restore,
        "Must recognize restorable staged file"
    );

    // Step 4: Self-healing on boot
    let remediation = journal.self_heal_on_boot().expect("self-heal failed");
    assert_eq!(remediation.len(), 1);
    match &remediation[0].outcome {
        RemediationOutcome::RestoredToOriginalPath(path) => {
            assert_eq!(path, &original_target);
        }
        other => panic!("Expected RestoredToOriginalPath, got {:?}", other),
    }

    // Step 5: Verify filesystem state after self-healing
    assert!(original_target.exists(), "Original target must be restored");
    assert!(
        !staging_path.exists(),
        "Staging path must be removed after restore"
    );
    let content = fs::read_to_string(&original_target).expect("read failed");
    assert_eq!(content, "IMPORTANT RESTORABLE USER DATA");

    // Step 6: Verify journal reflects resolved state
    let post_status = journal.inspect_dirty_shutdown().expect("inspect failed");
    assert!(
        !post_status.has_interrupted,
        "Journal must be clear of dirty in-flight records"
    );
}

#[test]
fn test_disk_space_exhaustion_circuit_breaker() {
    let dir = tempdir().expect("tempdir failed");
    let test_path = dir.path().join("probe.tmp");
    fs::write(&test_path, b"x").expect("write probe failed");

    // Zero extra bytes required on existing volume (should pass if volume has >= 500 MB free)
    let normal_check = CrashRecoveryJournal::check_disk_space_guard(&test_path, 0);
    // On systems with > 500 MB free, this is Ok. On critically low test VMs, it catches properly.
    if let Err(CoreError::DiskSpaceExhaustionGuard {
        available_bytes,
        required_bytes,
    }) = normal_check
    {
        assert!(available_bytes < required_bytes);
    } else {
        assert!(normal_check.is_ok());
    }

    // Unreasonable requirement (10,000 Terabytes) MUST trip the circuit breaker
    let huge_bytes = 10_000 * 1024 * 1024 * 1024 * 1024u64;
    let fail_check = CrashRecoveryJournal::check_disk_space_guard(&test_path, huge_bytes);
    match fail_check {
        Err(CoreError::DiskSpaceExhaustionGuard {
            available_bytes,
            required_bytes,
        }) => {
            assert!(
                available_bytes < required_bytes,
                "Available space must be less than required space"
            );
        }
        other => panic!("Expected DiskSpaceExhaustionGuard error, got {:?}", other),
    }
}
