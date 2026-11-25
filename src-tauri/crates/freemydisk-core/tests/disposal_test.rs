use freemydisk_core::cleanup::disposal::DisposalEngine;
use freemydisk_core::cleanup::plan::CleanupPlanItem;
use freemydisk_core::filesystem::journal::CrashRecoveryJournal;
use freemydisk_core::shared::progress::CancellationToken;
use freemydisk_platform::traits::{
    FileIdentity, PlatformError, PlatformFilesystem, StorageVolumeInfo,
};
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tempfile::tempdir;

struct MockDisposalPlatform {
    trash_should_fail: Arc<AtomicBool>,
}

impl MockDisposalPlatform {
    fn new(trash_should_fail: bool) -> Self {
        Self {
            trash_should_fail: Arc::new(AtomicBool::new(trash_should_fail)),
        }
    }
}

impl PlatformFilesystem for MockDisposalPlatform {
    fn trash_path(&self, path: &Path) -> Result<(), PlatformError> {
        if self.trash_should_fail.load(Ordering::SeqCst) {
            Err(PlatformError::TrashUnavailable(format!(
                "Simulated OS Recycle Bin failure on '{}'",
                path.display()
            )))
        } else {
            // Simulate successful trashing by deleting file
            if path.is_dir() {
                let _ = fs::remove_dir_all(path);
            } else {
                let _ = fs::remove_file(path);
            }
            Ok(())
        }
    }

    fn is_cloud_placeholder(&self, _path: &Path) -> Result<bool, PlatformError> {
        Ok(false)
    }

    fn get_file_identity(&self, path: &Path) -> Result<FileIdentity, PlatformError> {
        let meta = fs::symlink_metadata(path)?;
        Ok(FileIdentity {
            device_id: 1,
            file_index: meta.len(),
            link_count: 1,
            is_reparse_or_symlink: false,
        })
    }

    fn acquire_cross_process_lock(
        &self,
        lock_path: &Path,
    ) -> Result<Box<dyn std::any::Any + Send + Sync>, PlatformError> {
        if let Some(parent) = lock_path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let file = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(lock_path)?;
        Ok(Box::new(file))
    }

    fn list_volumes(&self) -> Result<Vec<StorageVolumeInfo>, PlatformError> {
        Ok(Vec::new())
    }
}

#[test]
fn test_trash_failure_never_falls_back_to_permanent_delete() {
    let temp = tempdir().unwrap();
    let target_file = temp.path().join("precious_file.txt");
    fs::write(&target_file, b"Do not permanently delete me!").unwrap();

    let journal_db = temp.path().join("journal.db");
    let journal = CrashRecoveryJournal::open(&journal_db).unwrap();
    let lock_dir = temp.path().join("locks");

    let platform = MockDisposalPlatform::new(true); // TRASH WILL FAIL!
    let cancel = CancellationToken::new();

    let plan_item = CleanupPlanItem {
        original_path: target_file.clone(),
        canonical_path: target_file.clone(),
        size_bytes: 29,
        is_dir: false,
        matched_rules: vec!["test_rule".to_string()],
        default_action: "trash".to_string(),
        verified_rebuildable: false,
        protect_subpaths: Vec::new(),
        risk: "safe".to_string(),
    };

    let summary = DisposalEngine::execute_plan(
        &[plan_item],
        &platform,
        &journal,
        &lock_dir,
        false, // always_trash_override = false
        &cancel,
    )
    .unwrap();

    // Invariant 1: Disposal reported failure
    assert_eq!(summary.failed_items, 1);
    assert_eq!(summary.successful_items, 0);
    assert_eq!(summary.total_freed_bytes, 0);
    assert_eq!(summary.failed_trash_paths.len(), 1);

    // Invariant 2: Target file MUST STILL EXIST on disk (Zero Auto Fallback!)
    assert!(
        target_file.exists(),
        "CRITICAL SAFETY VIOLATION: File was deleted despite trash failure!"
    );
    let content = fs::read_to_string(&target_file).unwrap();
    assert_eq!(content, "Do not permanently delete me!");

    // Invariant 3: Journal records status as failed: trash_unavailable
    let in_flight = journal.list_in_flight().unwrap();
    assert_eq!(
        in_flight.len(),
        0,
        "Item should have exited in_flight status"
    );
}

#[test]
fn test_manual_permanent_delete_reuses_standard_staging_pipeline() {
    let temp = tempdir().unwrap();
    let target_file = temp.path().join("rebuildable_cache.dat");
    fs::write(&target_file, b"cached rebuildable data").unwrap();

    let journal_db = temp.path().join("journal.db");
    let journal = CrashRecoveryJournal::open(&journal_db).unwrap();
    let lock_dir = temp.path().join("locks");

    let platform = MockDisposalPlatform::new(true);

    let result = DisposalEngine::execute_manual_permanent_delete(
        &target_file,
        &journal,
        &platform,
        &lock_dir,
    )
    .unwrap();

    // Verify deletion succeeded
    assert!(result.success);
    assert_eq!(result.route_used, "permanent");
    assert!(
        !target_file.exists(),
        "Target file should have been removed"
    );
    assert_eq!(result.bytes_freed, 23);
}

#[test]
fn test_rebuildable_item_is_kept_when_trash_fails_under_always_trash() {
    let temp = tempdir().unwrap();
    let target_file = temp.path().join("rebuildable_cache.bin");
    fs::write(&target_file, b"cache").unwrap();

    let journal = CrashRecoveryJournal::open(&temp.path().join("journal.db")).unwrap();
    let lock_dir = temp.path().join("locks");
    let platform = MockDisposalPlatform::new(true);
    let cancel = CancellationToken::new();

    let plan_item = CleanupPlanItem {
        original_path: target_file.clone(),
        canonical_path: target_file.clone(),
        size_bytes: 5,
        is_dir: false,
        matched_rules: vec!["rebuildable_rule".to_string()],
        default_action: "permanent".to_string(),
        verified_rebuildable: true,
        protect_subpaths: Vec::new(),
        risk: "safe".to_string(),
    };

    let summary =
        DisposalEngine::execute_plan(&[plan_item], &platform, &journal, &lock_dir, true, &cancel)
            .unwrap();

    assert_eq!(summary.successful_items, 0);
    assert_eq!(summary.failed_trash_paths, vec![target_file.clone()]);
    assert!(
        target_file.exists(),
        "File was deleted although trash failed"
    );
}

#[test]
fn test_extra_safe_override_forces_trash_route() {
    let temp = tempdir().unwrap();
    let target_file = temp.path().join("rebuildable_target.tmp");
    fs::write(&target_file, b"temp data").unwrap();

    let journal_db = temp.path().join("journal.db");
    let journal = CrashRecoveryJournal::open(&journal_db).unwrap();
    let lock_dir = temp.path().join("locks");

    let platform = MockDisposalPlatform::new(false); // Trash will succeed
    let cancel = CancellationToken::new();

    let plan_item = CleanupPlanItem {
        original_path: target_file.clone(),
        canonical_path: target_file.clone(),
        size_bytes: 9,
        is_dir: false,
        matched_rules: vec!["rebuildable_rule".to_string()],
        default_action: "permanent".to_string(), // Rule requested permanent delete
        verified_rebuildable: true,              // Rule is rebuildable
        protect_subpaths: Vec::new(),
        risk: "safe".to_string(),
    };

    // Execute with always_trash_override = true
    let summary = DisposalEngine::execute_plan(
        &[plan_item],
        &platform,
        &journal,
        &lock_dir,
        true, // "Always Trash" override enabled
        &cancel,
    )
    .unwrap();

    assert_eq!(summary.successful_items, 1);
    assert_eq!(
        summary.results[0].route_used, "trash",
        "Always Trash override did not force trash route!"
    );
}
