use freemydisk_core::shared::progress::CancellationToken;
use freemydisk_core::storage::analyzer::StorageAnalyzer;
use freemydisk_platform::traits::{
    FileIdentity, PlatformError, PlatformFilesystem, StorageVolumeInfo,
};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tempfile::tempdir;

struct MockPlatform {
    identities: Mutex<HashMap<PathBuf, u64>>,
}

impl MockPlatform {
    fn new() -> Self {
        Self {
            identities: Mutex::new(HashMap::new()),
        }
    }
}

impl PlatformFilesystem for MockPlatform {
    fn trash_path(&self, _path: &Path) -> Result<(), PlatformError> {
        Ok(())
    }
    fn is_cloud_placeholder(&self, _path: &Path) -> Result<bool, PlatformError> {
        Ok(false)
    }
    fn get_file_identity(&self, path: &Path) -> Result<FileIdentity, PlatformError> {
        let mut map = self.identities.lock().unwrap();
        let next_idx = map.len() as u64 + 1;
        let file_index = *map.entry(path.to_path_buf()).or_insert(next_idx);
        Ok(FileIdentity {
            device_id: 1,
            file_index,
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
    fn list_volumes(&self) -> Result<Vec<StorageVolumeInfo>, PlatformError> {
        Ok(Vec::new())
    }
}

#[test]
fn test_storage_analyzer_scan_hierarchy() {
    let temp = tempdir().unwrap();
    let root = temp.path();

    let sub_a = root.join("FolderA");
    let sub_b = root.join("FolderB");
    fs::create_dir_all(&sub_a).unwrap();
    fs::create_dir_all(&sub_b).unwrap();

    let file_a1 = sub_a.join("data1.bin");
    let file_a2 = sub_a.join("data2.bin");
    let file_b1 = sub_b.join("data3.bin");

    fs::write(&file_a1, vec![0u8; 30_000]).unwrap();
    fs::write(&file_a2, vec![0u8; 20_000]).unwrap();
    fs::write(&file_b1, vec![0u8; 10_000]).unwrap();

    let platform = MockPlatform::new();
    let cancel = CancellationToken::new();

    let tree = StorageAnalyzer::scan_directory(root, 3, &platform, &cancel).unwrap();

    assert_eq!(tree.size_bytes, 60_000);
    assert_eq!(tree.file_count, 3);
    assert!(tree.is_dir);

    // Verify children sorted by size descending: FolderA (50K) then FolderB (10K)
    assert_eq!(tree.children.len(), 2);
    assert_eq!(tree.children[0].name, "FolderA");
    assert_eq!(tree.children[0].size_bytes, 50_000);
    assert_eq!(tree.children[1].name, "FolderB");
    assert_eq!(tree.children[1].size_bytes, 10_000);

    // CSV export test
    let csv = StorageAnalyzer::export_to_csv(&tree).unwrap();
    assert!(csv.contains("FolderA"));
    assert!(csv.contains("50000"));

    // JSON export test
    let json = StorageAnalyzer::export_to_json(&tree).unwrap();
    assert!(json.contains("FolderA"));
}
