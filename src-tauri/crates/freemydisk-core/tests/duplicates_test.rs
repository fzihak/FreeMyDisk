use freemydisk_core::shared::progress::CancellationToken;
use freemydisk_core::storage::duplicates::{DuplicateDetector, SelectionHeuristic};
use freemydisk_platform::traits::{
    FileIdentity, PlatformError, PlatformFilesystem, StorageVolumeInfo,
};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tempfile::tempdir;

struct MockHardlinkPlatform {
    identities: Arc<Mutex<HashMap<PathBuf, FileIdentity>>>,
}

impl MockHardlinkPlatform {
    fn new() -> Self {
        Self {
            identities: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    fn register_identity(&self, path: PathBuf, identity: FileIdentity) {
        self.identities.lock().unwrap().insert(path, identity);
    }
}

impl PlatformFilesystem for MockHardlinkPlatform {
    fn trash_path(&self, _path: &Path) -> Result<(), PlatformError> {
        Ok(())
    }

    fn is_cloud_placeholder(&self, _path: &Path) -> Result<bool, PlatformError> {
        Ok(false)
    }

    fn get_file_identity(&self, path: &Path) -> Result<FileIdentity, PlatformError> {
        if let Some(id) = self.identities.lock().unwrap().get(path) {
            Ok(id.clone())
        } else {
            let meta = fs::symlink_metadata(path)?;
            Ok(FileIdentity {
                device_id: 1,
                file_index: meta.len(),
                link_count: 1,
                is_reparse_or_symlink: false,
            })
        }
    }

    fn acquire_cross_process_lock(
        &self,
        _lock_path: &Path,
    ) -> Result<Box<dyn std::any::Any + Send + Sync>, PlatformError> {
        let temp_file = tempfile::NamedTempFile::new()?;
        Ok(Box::new(temp_file))
    }

    fn list_volumes(&self) -> Result<Vec<StorageVolumeInfo>, PlatformError> {
        Ok(Vec::new())
    }
}

#[test]
fn test_hardlink_shared_blocks_report_zero_reclaimable_savings() {
    let temp = tempdir().unwrap();
    let file1 = temp.path().join("source.dat");
    let file2 = temp.path().join("hardlink.dat");

    let content = b"Identical disk block contents shared via NTFS hardlink";
    fs::write(&file1, content).unwrap();
    fs::write(&file2, content).unwrap();

    let platform = MockHardlinkPlatform::new();
    // Simulate hardlink: SAME device_id and file_index (inode)
    let shared_identity = FileIdentity {
        device_id: 100,
        file_index: 9999, // Same inode
        link_count: 2,
        is_reparse_or_symlink: false,
    };

    platform.register_identity(file1.clone(), shared_identity.clone());
    platform.register_identity(file2.clone(), shared_identity);

    let cancel = CancellationToken::new();
    let result = DuplicateDetector::scan_duplicates(
        &[temp.path().to_path_buf()],
        1, // min size 1 byte
        &platform,
        &cancel,
    )
    .unwrap();

    // Invariant: Files are detected as duplicates, BUT physical reclaimable savings = 0!
    assert_eq!(result.total_groups, 1);
    let group = &result.groups[0];
    assert_eq!(group.files.len(), 2);
    assert_eq!(
        group.potential_savings_bytes, 0,
        "CRITICAL SAFETY INVARIANT VIOLATION: Hardlinks sharing disk blocks must report 0 savings!"
    );
    assert!(group.files[0].is_hardlink_or_clone);
    assert!(group.files[1].is_hardlink_or_clone);
}

#[test]
fn test_distinct_duplicate_files_report_accurate_savings() {
    let temp = tempdir().unwrap();
    let file1 = temp.path().join("copy1.dat");
    let file2 = temp.path().join("copy2.dat");
    let file3 = temp.path().join("copy3.dat");

    let content = vec![42u8; 1024]; // 1024 bytes each
    fs::write(&file1, &content).unwrap();
    fs::write(&file2, &content).unwrap();
    fs::write(&file3, &content).unwrap();

    let platform = MockHardlinkPlatform::new();
    // 3 distinct files with different inodes
    platform.register_identity(
        file1.clone(),
        FileIdentity {
            device_id: 1,
            file_index: 101,
            link_count: 1,
            is_reparse_or_symlink: false,
        },
    );
    platform.register_identity(
        file2.clone(),
        FileIdentity {
            device_id: 1,
            file_index: 102,
            link_count: 1,
            is_reparse_or_symlink: false,
        },
    );
    platform.register_identity(
        file3.clone(),
        FileIdentity {
            device_id: 1,
            file_index: 103,
            link_count: 1,
            is_reparse_or_symlink: false,
        },
    );

    let cancel = CancellationToken::new();
    let mut result =
        DuplicateDetector::scan_duplicates(&[temp.path().to_path_buf()], 1, &platform, &cancel)
            .unwrap();

    assert_eq!(result.total_groups, 1);
    let group = &result.groups[0];
    assert_eq!(group.files.len(), 3);
    // (3 copies - 1 original) * 1024 bytes = 2048 bytes
    assert_eq!(group.potential_savings_bytes, 2048);

    // Test selection heuristics
    DuplicateDetector::apply_selection_heuristic(
        &mut result.groups,
        SelectionHeuristic::UnselectAll,
    );
    for f in &result.groups[0].files {
        assert!(!f.selected);
    }
}

#[test]
fn test_hash_cache_lookup_and_acceleration() {
    use freemydisk_core::storage::duplicates::HashCache;

    let cache = HashCache::in_memory().unwrap();
    let temp = tempdir().unwrap();
    let file = temp.path().join("cached_test.bin");
    fs::write(&file, b"Cache acceleration test content").unwrap();

    let meta = fs::metadata(&file).unwrap();
    let size = meta.len();
    let mtime = meta
        .modified()
        .unwrap()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();

    // 1. Initially not cached
    assert!(cache.lookup(&file, size, mtime).is_none());

    // 2. Store hashes
    cache.store(&file, size, mtime, "sample123", "fullhash456");

    // 3. Lookup should hit
    let cached = cache
        .lookup(&file, size, mtime)
        .expect("Cache hit expected");
    assert_eq!(cached.sample_hash, "sample123");
    assert_eq!(cached.full_hash, "fullhash456");

    // 4. Invalidation on modified time change
    assert!(cache.lookup(&file, size, mtime + 10).is_none());

    // 5. Invalidation on size change
    assert!(cache.lookup(&file, size + 5, mtime).is_none());
}

#[test]
fn test_duplicate_folder_aggregation() {
    use freemydisk_core::storage::duplicates::HashCache;

    let temp = tempdir().unwrap();
    let dir_a = temp.path().join("ProjectFolderA");
    let dir_b = temp.path().join("ProjectFolderB_Copy");

    fs::create_dir_all(&dir_a).unwrap();
    fs::create_dir_all(&dir_b).unwrap();

    // Create 3 identical files in both directories
    fs::write(dir_a.join("assets.bin"), vec![1u8; 1024]).unwrap();
    fs::write(dir_b.join("assets.bin"), vec![1u8; 1024]).unwrap();

    fs::write(dir_a.join("config.json"), vec![2u8; 512]).unwrap();
    fs::write(dir_b.join("config.json"), vec![2u8; 512]).unwrap();

    fs::write(dir_a.join("readme.txt"), vec![3u8; 256]).unwrap();
    fs::write(dir_b.join("readme.txt"), vec![3u8; 256]).unwrap();

    let platform = MockHardlinkPlatform::new();
    let cancel = CancellationToken::new();
    let cache = HashCache::in_memory().unwrap();

    // First scan: populates cache and groups folders
    let res1 = DuplicateDetector::scan_duplicates_with_cache(
        &[temp.path().to_path_buf()],
        1,
        &platform,
        Some(&cache),
        &cancel,
    )
    .unwrap();

    assert_eq!(res1.total_groups, 3, "Expected 3 duplicate file groups");
    assert_eq!(
        res1.total_folder_groups, 1,
        "Expected 1 duplicate folder group"
    );

    let folder_group = &res1.folder_groups[0];
    assert_eq!(folder_group.total_files, 3);
    assert_eq!(folder_group.folder_size_bytes, 1792);
    assert_eq!(folder_group.potential_savings_bytes, 1792);
    assert_eq!(folder_group.directories.len(), 2);

    // Second scan with warm cache: should verify cache hits!
    let res2 = DuplicateDetector::scan_duplicates_with_cache(
        &[temp.path().to_path_buf()],
        1,
        &platform,
        Some(&cache),
        &cancel,
    )
    .unwrap();

    assert!(res2.cache_hits > 0, "Second scan must produce cache hits");
    assert_eq!(res2.total_folder_groups, 1);
}

fn entry(path: &Path, selected: bool) -> freemydisk_core::storage::duplicates::DuplicateFileEntry {
    freemydisk_core::storage::duplicates::DuplicateFileEntry {
        path: path.to_path_buf(),
        size_bytes: fs::metadata(path).map(|m| m.len()).unwrap_or(0),
        modified_at: 0,
        device_id: 0,
        file_index: 0,
        is_hardlink_or_clone: false,
        selected,
    }
}

fn group(
    files: Vec<freemydisk_core::storage::duplicates::DuplicateFileEntry>,
) -> freemydisk_core::storage::duplicates::DuplicateGroup {
    freemydisk_core::storage::duplicates::DuplicateGroup {
        group_id: "g".to_string(),
        hash: "client-supplied-value-is-ignored".to_string(),
        file_size: files[0].size_bytes,
        files,
        potential_savings_bytes: 0,
    }
}

#[test]
fn test_trash_duplicates_never_removes_every_copy_or_changed_files() {
    let dir = tempdir().unwrap();
    let a = dir.path().join("a.bin");
    let b = dir.path().join("b.bin");
    let c = dir.path().join("c.bin");
    fs::write(&a, b"same content").unwrap();
    fs::write(&b, b"same content").unwrap();
    fs::write(&c, b"edited after scan").unwrap();

    let journal = freemydisk_core::filesystem::journal::CrashRecoveryJournal::open(
        &dir.path().join("journal.db"),
    )
    .unwrap();
    let lock_dir = dir.path().join("locks");
    let platform = MockHardlinkPlatform::new();
    let cancel = CancellationToken::new();

    // Every copy selected: nothing may be removed.
    let all_selected = group(vec![entry(&a, true), entry(&b, true)]);
    let summary = DuplicateDetector::batch_trash_duplicates(
        &[all_selected],
        &platform,
        &journal,
        &lock_dir,
        &cancel,
    )
    .unwrap();
    assert_eq!(summary.successful_items, 0);
    assert_eq!(summary.failed_items, 2);

    // A selected file whose content no longer matches the kept copy is left alone.
    let changed = group(vec![entry(&a, false), entry(&b, true), entry(&c, true)]);
    let summary = DuplicateDetector::batch_trash_duplicates(
        &[changed],
        &platform,
        &journal,
        &lock_dir,
        &cancel,
    )
    .unwrap();
    assert_eq!(summary.successful_items, 1);
    assert_eq!(summary.failed_items, 1);
    let rejected = summary.results.iter().find(|r| !r.success).unwrap();
    assert_eq!(rejected.path, c);
}

struct NoIdentityPlatform;

impl PlatformFilesystem for NoIdentityPlatform {
    fn trash_path(&self, _path: &Path) -> Result<(), PlatformError> {
        Ok(())
    }

    fn is_cloud_placeholder(&self, _path: &Path) -> Result<bool, PlatformError> {
        Ok(false)
    }

    fn get_file_identity(&self, _path: &Path) -> Result<FileIdentity, PlatformError> {
        Err(PlatformError::OperationFailed(
            "identity unavailable".to_string(),
        ))
    }

    fn acquire_cross_process_lock(
        &self,
        _lock_path: &Path,
    ) -> Result<Box<dyn std::any::Any + Send + Sync>, PlatformError> {
        Ok(Box::new(()))
    }

    fn list_volumes(&self) -> Result<Vec<StorageVolumeInfo>, PlatformError> {
        Ok(Vec::new())
    }
}

#[test]
fn test_unknown_file_identity_never_merges_distinct_files() {
    let dir = tempdir().unwrap();
    let a = dir.path().join("a.bin");
    let b = dir.path().join("b.bin");
    fs::write(&a, vec![7u8; 4096]).unwrap();
    fs::write(&b, vec![7u8; 4096]).unwrap();

    let result = DuplicateDetector::scan_duplicates(
        &[dir.path().to_path_buf()],
        1,
        &NoIdentityPlatform,
        &CancellationToken::new(),
    )
    .unwrap();

    let group = &result.groups[0];
    assert_eq!(group.potential_savings_bytes, 4096);
    assert!(group.files.iter().all(|f| !f.is_hardlink_or_clone));
}
