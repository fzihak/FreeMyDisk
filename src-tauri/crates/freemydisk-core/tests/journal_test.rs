use freemydisk_core::filesystem::journal::{CrashRecoveryJournal, RemediationOutcome};
use std::fs;
use tempfile::tempdir;

#[test]
fn test_journal_intent_and_completion() {
    let dir = tempdir().unwrap();
    let db_path = dir.path().join("journal.db");
    let journal = CrashRecoveryJournal::open(&db_path).unwrap();

    let target = dir.path().join("cache.dat");
    let id = journal
        .write_intent("session_1", &target, None, "trash")
        .unwrap();

    let in_flight = journal.list_in_flight().unwrap();
    assert_eq!(in_flight.len(), 1);
    assert_eq!(in_flight[0].id, id);
    assert_eq!(in_flight[0].status, "in_flight");

    journal.mark_completed(id).unwrap();
    let remaining = journal.list_in_flight().unwrap();
    assert_eq!(remaining.len(), 0);
}

#[test]
fn test_recovery_dismiss_single_show_semantics() {
    let dir = tempdir().unwrap();
    let db_path = dir.path().join("journal.db");
    let journal = CrashRecoveryJournal::open(&db_path).unwrap();

    let target = dir.path().join("cache2.dat");
    journal
        .write_intent("session_2", &target, None, "trash")
        .unwrap();

    let in_flight_before = journal.list_in_flight().unwrap();
    assert_eq!(in_flight_before.len(), 1);

    // User clicks dismiss
    let acknowledged = journal.acknowledge_in_flight().unwrap();
    assert_eq!(acknowledged, 1);

    // Subsequent query on next launch should find 0 in-flight records
    let in_flight_after = journal.list_in_flight().unwrap();
    assert_eq!(
        in_flight_after.len(),
        0,
        "Banner must not repeat on subsequent queries"
    );
}

#[test]
fn test_staged_crash_rollback_branch_a_target_free() {
    let dir = tempdir().unwrap();
    let db_path = dir.path().join("journal.db");
    let journal = CrashRecoveryJournal::open(&db_path).unwrap();

    let target = dir.path().join("important_cache.bin");
    let staging = dir.path().join(".fmd-staging-12345");

    // Simulate file moved to staging before crash
    fs::write(&staging, b"cache content").unwrap();
    assert!(!target.exists());
    assert!(staging.exists());

    let id = journal
        .write_intent("session_3", &target, Some(&staging), "permanent")
        .unwrap();

    // Run recovery
    let remediations = journal.remediate_staged_crashes().unwrap();
    assert_eq!(remediations.len(), 1);
    assert_eq!(remediations[0].id, id);

    match &remediations[0].outcome {
        RemediationOutcome::RestoredToOriginalPath(p) => {
            assert_eq!(p, &target);
        }
        _ => panic!("Expected RestoredToOriginalPath"),
    }

    // Verify file was moved back to original path
    assert!(target.exists());
    assert!(!staging.exists());
}

#[test]
fn test_staged_crash_rollback_branch_b_target_recreated_conflict() {
    let dir = tempdir().unwrap();
    let db_path = dir.path().join("journal.db");
    let journal = CrashRecoveryJournal::open(&db_path).unwrap();

    let target = dir.path().join("conflict_cache.bin");
    let staging = dir.path().join(".fmd-staging-conflict");

    // Simulate staging file exists AND target was recreated by an external process
    fs::write(&staging, b"staged old version").unwrap();
    fs::write(&target, b"newly created version").unwrap();

    let id = journal
        .write_intent("session_4", &target, Some(&staging), "permanent")
        .unwrap();

    let remediations = journal.remediate_staged_crashes().unwrap();
    assert_eq!(remediations.len(), 1);
    assert_eq!(remediations[0].id, id);

    match &remediations[0].outcome {
        RemediationOutcome::ConflictTargetExistsRequiresManualReview(s) => {
            assert_eq!(s, &staging);
        }
        _ => panic!("Expected ConflictTargetExistsRequiresManualReview"),
    }

    // Target must NOT be overwritten!
    assert_eq!(fs::read(&target).unwrap(), b"newly created version");
    assert!(staging.exists());

    // User resolves conflict manually
    journal.mark_resolved_manual(id).unwrap();
}

#[test]
fn test_30_day_retention_purge() {
    let dir = tempdir().unwrap();
    let db_path = dir.path().join("journal.db");
    let journal = CrashRecoveryJournal::open(&db_path).unwrap();

    let target = dir.path().join("old.bin");
    let id = journal
        .write_intent("session_old", &target, None, "trash")
        .unwrap();
    journal.mark_completed(id).unwrap();

    // 0 days retention should purge completed records immediately
    let purged = journal.purge_old_records(0).unwrap();
    assert!(purged >= 1);
}

#[test]
fn test_emergency_wal_flush_and_disk_space_guard() {
    let dir = tempdir().unwrap();
    let db_path = dir.path().join("journal.db");
    let journal = CrashRecoveryJournal::open(&db_path).unwrap();

    let target = dir.path().join("file.bin");
    let _id = journal
        .write_intent("session_flush", &target, None, "trash")
        .unwrap();

    // Emergency flush should succeed without errors
    assert!(journal.emergency_flush().is_ok());

    // Disk space guard with 0 bytes required should succeed on existing volume
    let guard_res = CrashRecoveryJournal::check_disk_space_guard(dir.path(), 1024);
    assert!(guard_res.is_ok());

    // Disk space guard with an absurdly huge required size (10,000 TB) must trigger DiskSpaceExhaustionGuard
    let huge_req = 10_000_000_000_000_000u64;
    let guard_fail = CrashRecoveryJournal::check_disk_space_guard(dir.path(), huge_req);
    assert!(
        guard_fail.is_err(),
        "Exceeding disk space must trigger guard"
    );
}
