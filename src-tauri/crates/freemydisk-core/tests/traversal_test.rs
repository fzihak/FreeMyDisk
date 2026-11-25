use freemydisk_core::shared::progress::CancellationToken;
use freemydisk_core::storage::traversal::DirectoryTraversal;
use freemydisk_platform::traits::{FileIdentity, PlatformError, PlatformFilesystem};
use std::fs;
use std::path::Path;
use std::sync::Arc;
use tempfile::tempdir;

struct MockPlatform;

impl PlatformFilesystem for MockPlatform {
    fn trash_path(&self, _path: &Path) -> Result<(), PlatformError> {
        Ok(())
    }

    fn is_cloud_placeholder(&self, path: &Path) -> Result<bool, PlatformError> {
        // Mark placeholder if filename contains "placeholder"
        Ok(path.to_string_lossy().contains("placeholder"))
    }

    fn get_file_identity(&self, path: &Path) -> Result<FileIdentity, PlatformError> {
        use std::hash::{Hash, Hasher};
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        path.hash(&mut hasher);
        let hash = hasher.finish();
        Ok(FileIdentity {
            device_id: 1,
            file_index: hash,
            link_count: 1,
            is_reparse_or_symlink: false,
        })
    }

    fn acquire_cross_process_lock(
        &self,
        _lock_path: &Path,
    ) -> Result<Box<dyn std::any::Any + Send + Sync>, PlatformError> {
        Ok(Box::new(()))
    }

    fn list_volumes(
        &self,
    ) -> Result<Vec<freemydisk_platform::traits::StorageVolumeInfo>, PlatformError> {
        Ok(Vec::new())
    }
}

#[test]
fn test_directory_traversal_basic() {
    let dir = tempdir().unwrap();
    let sub = dir.path().join("subdir");
    fs::create_dir(&sub).unwrap();

    let file1 = dir.path().join("file1.txt");
    fs::write(&file1, b"hello world").unwrap();

    let file2 = sub.join("file2.txt");
    fs::write(&file2, b"12345678").unwrap();

    let platform = Arc::new(MockPlatform);
    let cancellation = CancellationToken::new();
    let traverser = DirectoryTraversal::new(platform, cancellation);

    let mut reported_progress = false;
    let results = traverser
        .scan(dir.path(), |_p| {
            reported_progress = true;
        })
        .unwrap();

    assert!(reported_progress);
    assert_eq!(results.len(), 3); // subdir, file1.txt, file2.txt

    let total_size: u64 = results.iter().map(|e| e.size_bytes).sum();
    assert_eq!(total_size, 11 + 8);
}

#[test]
fn test_cancellation_terminates_promptly() {
    let dir = tempdir().unwrap();
    for i in 0..10 {
        fs::write(dir.path().join(format!("file_{}.txt", i)), b"test").unwrap();
    }

    let platform = Arc::new(MockPlatform);
    let cancellation = CancellationToken::new();
    cancellation.cancel(); // Pre-cancel

    let traverser = DirectoryTraversal::new(platform, cancellation);
    let res = traverser.scan(dir.path(), |_| {});
    assert!(res.is_err(), "Must abort with Cancelled error");
}
