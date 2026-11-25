use freemydisk_core::filesystem::journal::CrashRecoveryJournal;
use freemydisk_core::shared::errors::CoreError;
use freemydisk_core::shared::ipc_errors::IpcError;
use freemydisk_core::shared::paths::expand_path_variables;
use freemydisk_core::system_maintenance::elevation_client::{ElevatedRequest, ElevatedResponse};
use freemydisk_platform::traits::PlatformError;
use std::path::{Path, PathBuf};
use tempfile::tempdir;

#[test]
fn test_structured_ipc_errors_conversions() {
    // 1. CoreError::ProtectedPath -> PROTECTED_PATH (not recoverable)
    let prot_err = CoreError::ProtectedPath(PathBuf::from(r"C:\Windows\System32"));
    let ipc_prot = IpcError::from(prot_err);
    assert_eq!(ipc_prot.code, "PROTECTED_PATH");
    assert!(!ipc_prot.recoverable);
    assert_eq!(ipc_prot.path.as_deref(), Some(r"C:\Windows\System32"));

    // 2. CoreError::LockBusy -> LOCK_BUSY (recoverable)
    let lock_err = CoreError::LockBusy;
    let ipc_lock = IpcError::from(lock_err);
    assert_eq!(ipc_lock.code, "LOCK_BUSY");
    assert!(ipc_lock.recoverable);

    // 3. CoreError::Cancelled -> CANCELLED
    let cancel_err = CoreError::Cancelled;
    let ipc_cancel = IpcError::from(cancel_err);
    assert_eq!(ipc_cancel.code, "CANCELLED");
    assert!(ipc_cancel.recoverable);

    // 4. PlatformError::ElevationRequired -> ELEVATION_REQUIRED
    let elev_err = PlatformError::ElevationRequired("Action requires Administrator".to_string());
    let ipc_elev = IpcError::from(elev_err);
    assert_eq!(ipc_elev.code, "ELEVATION_REQUIRED");
    assert!(ipc_elev.recoverable);

    // 5. Serialization / Deserialization
    let json = serde_json::to_string(&ipc_prot).unwrap();
    let deserialized: IpcError = serde_json::from_str(&json).unwrap();
    assert_eq!(deserialized.code, "PROTECTED_PATH");
}

#[test]
fn test_journal_scan_checkpoints() {
    let temp = tempdir().unwrap();
    let db_path = temp.path().join("journal.db");
    let journal = CrashRecoveryJournal::open(&db_path).unwrap();

    let scan_id = "test-scan-101";

    // Initially no checkpoint
    assert!(journal.get_scan_checkpoint(scan_id).unwrap().is_none());

    // Save checkpoint
    journal
        .save_scan_checkpoint(
            scan_id,
            "duplicate_finder",
            r"C:\Projects\TestRepo\node_modules",
            12_450,
            850_000_000,
        )
        .unwrap();

    // Query checkpoint
    let cp = journal
        .get_scan_checkpoint(scan_id)
        .unwrap()
        .expect("Checkpoint must exist");
    assert_eq!(cp.0, "duplicate_finder");
    assert_eq!(cp.1, r"C:\Projects\TestRepo\node_modules");
    assert_eq!(cp.2, 12_450);
    assert_eq!(cp.3, 850_000_000);

    // Update checkpoint
    journal
        .save_scan_checkpoint(
            scan_id,
            "duplicate_finder",
            r"C:\Projects\TestRepo\build",
            15_000,
            1_200_000_000,
        )
        .unwrap();

    let updated = journal.get_scan_checkpoint(scan_id).unwrap().unwrap();
    assert_eq!(updated.1, r"C:\Projects\TestRepo\build");
    assert_eq!(updated.2, 15_000);

    // Clear checkpoint
    journal.clear_scan_checkpoint(scan_id).unwrap();
    assert!(journal.get_scan_checkpoint(scan_id).unwrap().is_none());
}

#[test]
fn test_journal_undo_rollback_records() {
    let temp = tempdir().unwrap();
    let db_path = temp.path().join("journal.db");
    let journal = CrashRecoveryJournal::open(&db_path).unwrap();

    let orig = Path::new(r"C:\Users\User\AppData\Local\App\cache.db");
    let backup = Path::new(r"C:\Users\User\AppData\Local\FreeMyDisk\quarantine\cache.db.bak");

    let row_id = journal
        .record_undo_backup("session-999", orig, backup, 24)
        .unwrap();
    assert!(row_id > 0);

    let active = journal.list_active_undo_backups().unwrap();
    assert_eq!(active.len(), 1);
    assert_eq!(active[0].0, row_id);
    assert_eq!(active[0].1, "session-999");
    assert_eq!(active[0].2, orig);
    assert_eq!(active[0].3, backup);
}

#[test]
fn test_path_variable_expansion_windows_defaults() {
    let template = "${local_app_data}\\Temp\\test.tmp";
    let expanded = expand_path_variables(template);
    let path_str = expanded.to_string_lossy();
    assert!(
        !path_str.contains("${local_app_data}"),
        "Variable must be replaced"
    );
    assert!(path_str.ends_with(r"\Temp\test.tmp") || path_str.ends_with("/Temp/test.tmp"));
}

#[test]
fn test_elevated_request_response_serialization() {
    let req = ElevatedRequest {
        operation: "dism_component_cleanup".to_string(),
        payload: String::new(),
        token: None,
    };
    let json = serde_json::to_string(&req).unwrap();
    let parsed: ElevatedRequest = serde_json::from_str(&json).unwrap();
    assert_eq!(parsed.operation, "dism_component_cleanup");

    let resp = ElevatedResponse {
        success: true,
        message: "Component store cleaned".to_string(),
    };
    let resp_json = serde_json::to_string(&resp).unwrap();
    let parsed_resp: ElevatedResponse = serde_json::from_str(&resp_json).unwrap();
    assert!(parsed_resp.success);
}
