use freemydisk_core::shared::progress::CancellationToken;
use freemydisk_core::storage::large_files::{FileCategory, LargeFilesScanner};
use std::fs;
use tempfile::tempdir;

#[test]
fn test_large_files_threshold_and_category_classification() {
    let temp = tempdir().unwrap();

    let movie_file = temp.path().join("vacation.mp4");
    let zip_file = temp.path().join("backup.zip");
    let doc_file = temp.path().join("report.pdf");
    let small_file = temp.path().join("small.txt");

    fs::write(&movie_file, vec![0u8; 100_000]).unwrap(); // 100KB
    fs::write(&zip_file, vec![0u8; 50_000]).unwrap(); // 50KB
    fs::write(&doc_file, vec![0u8; 20_000]).unwrap(); // 20KB
    fs::write(&small_file, vec![0u8; 500]).unwrap(); // 500B

    let cancel = CancellationToken::new();

    // Scan with threshold = 10,000 bytes (10KB)
    let result =
        LargeFilesScanner::scan_large_files(&[temp.path().to_path_buf()], 10_000, &cancel).unwrap();

    // Invariant 1: Threshold filters out small.txt (500B)
    assert_eq!(result.total_files, 3);
    assert_eq!(result.total_bytes, 170_000);

    // Invariant 2: Sorted by size descending
    assert_eq!(result.files[0].name, "vacation.mp4");
    assert_eq!(result.files[0].category, FileCategory::Media);
    assert_eq!(result.files[0].size_bytes, 100_000);

    assert_eq!(result.files[1].name, "backup.zip");
    assert_eq!(result.files[1].category, FileCategory::Archives);
    assert_eq!(result.files[1].size_bytes, 50_000);

    assert_eq!(result.files[2].name, "report.pdf");
    assert_eq!(result.files[2].category, FileCategory::Documents);
    assert_eq!(result.files[2].size_bytes, 20_000);
}

#[test]
fn test_category_extension_classification() {
    assert_eq!(
        LargeFilesScanner::classify_extension("mp4"),
        FileCategory::Media
    );
    assert_eq!(
        LargeFilesScanner::classify_extension("MKV"),
        FileCategory::Media
    );
    assert_eq!(
        LargeFilesScanner::classify_extension("7z"),
        FileCategory::Archives
    );
    assert_eq!(
        LargeFilesScanner::classify_extension("iso"),
        FileCategory::Archives
    );
    assert_eq!(
        LargeFilesScanner::classify_extension("docx"),
        FileCategory::Documents
    );
    assert_eq!(
        LargeFilesScanner::classify_extension("exe"),
        FileCategory::Binaries
    );
    assert_eq!(
        LargeFilesScanner::classify_extension("dll"),
        FileCategory::Binaries
    );
    assert_eq!(
        LargeFilesScanner::classify_extension("unknown_xyz"),
        FileCategory::Other
    );
}

struct MockPlatform;
impl freemydisk_platform::traits::PlatformFilesystem for MockPlatform {
    fn trash_path(
        &self,
        path: &std::path::Path,
    ) -> Result<(), freemydisk_platform::traits::PlatformError> {
        let _ = std::fs::remove_file(path);
        Ok(())
    }
    fn is_cloud_placeholder(
        &self,
        _path: &std::path::Path,
    ) -> Result<bool, freemydisk_platform::traits::PlatformError> {
        Ok(false)
    }
    fn get_file_identity(
        &self,
        path: &std::path::Path,
    ) -> Result<freemydisk_platform::traits::FileIdentity, freemydisk_platform::traits::PlatformError>
    {
        let meta = std::fs::symlink_metadata(path)?;
        Ok(freemydisk_platform::traits::FileIdentity {
            device_id: 1,
            file_index: meta.len(),
            link_count: 1,
            is_reparse_or_symlink: false,
        })
    }
    fn acquire_cross_process_lock(
        &self,
        lock_path: &std::path::Path,
    ) -> Result<Box<dyn std::any::Any + Send + Sync>, freemydisk_platform::traits::PlatformError>
    {
        if let Some(parent) = lock_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(lock_path)?;
        Ok(Box::new(file))
    }
    fn list_volumes(
        &self,
    ) -> Result<
        Vec<freemydisk_platform::traits::StorageVolumeInfo>,
        freemydisk_platform::traits::PlatformError,
    > {
        Ok(Vec::new())
    }
}

#[test]
fn test_large_files_batch_trash() {
    let temp = tempdir().unwrap();
    let file1 = temp.path().join("large_video_1.mp4");
    let file2 = temp.path().join("large_archive_2.zip");
    let file3 = temp.path().join("large_iso_3.iso");

    fs::write(&file1, vec![0u8; 200_000]).unwrap();
    fs::write(&file2, vec![0u8; 150_000]).unwrap();
    fs::write(&file3, vec![0u8; 100_000]).unwrap();

    let journal_db = temp.path().join("journal.db");
    let journal =
        freemydisk_core::filesystem::journal::CrashRecoveryJournal::open(&journal_db).unwrap();
    let lock_dir = temp.path().join("locks");
    fs::create_dir_all(&lock_dir).unwrap();

    let platform = MockPlatform;
    let paths = vec![file1.clone(), file2.clone(), file3.clone()];

    let summary =
        LargeFilesScanner::trash_large_files(&paths, &platform, &journal, &lock_dir).unwrap();

    assert_eq!(summary.total_requested_items, 3);
    assert_eq!(summary.successful_items, 3);
    assert_eq!(summary.failed_items, 0);
    // Moved to the Recycle Bin: still on the volume, so reported separately.
    assert_eq!(summary.recycled_bytes, 450_000);
    assert_eq!(summary.total_freed_bytes, 0);
    assert!(!file1.exists());
    assert!(!file2.exists());
    assert!(!file3.exists());
}

#[test]
fn test_large_files_never_lists_os_files() {
    let temp = tempdir().unwrap();
    let root = temp.path();
    for name in [
        "pagefile.sys",
        "swapfile.sys",
        "hiberfil.sys",
        "DumpStack.log.tmp",
        "HIBERFIL.SYS.old",
    ] {
        fs::write(root.join(name), vec![0u8; 50_000]).unwrap();
    }
    for dir in ["System Volume Information", "$Recycle.Bin"] {
        let d = root.join(dir).join("S-1-5-21");
        fs::create_dir_all(&d).unwrap();
        fs::write(d.join("$RXYZ.iso"), vec![0u8; 50_000]).unwrap();
    }
    let nested = root.join("Games").join("data");
    fs::create_dir_all(&nested).unwrap();
    fs::write(nested.join("level.pak"), vec![0u8; 60_000]).unwrap();

    let result = LargeFilesScanner::scan_large_files(
        &[root.to_path_buf()],
        10_000,
        &CancellationToken::new(),
    )
    .unwrap();
    let names: Vec<_> = result.files.iter().map(|f| f.name.clone()).collect();
    assert_eq!(
        names,
        vec!["level.pak".to_string(), "HIBERFIL.SYS.old".to_string()]
    );
    assert_eq!(result.total_bytes, 110_000);
    assert!(result.files[0].modified_at > 0);
}
