use freemydisk_core::storage::spill_store::{CandidateEntry, CandidateStore};
use std::path::PathBuf;
use tempfile::tempdir;

#[test]
fn test_candidate_store_memory_to_disk_spill_transition() {
    let temp = tempdir().unwrap();
    let threshold = 20;
    let mut store = CandidateStore::new(threshold, temp.path().to_path_buf());

    assert_eq!(store.len(), 0);
    assert!(!store.is_spilled());

    // 1. Insert 15 items: should stay in memory buffer
    for i in 0..15 {
        store
            .push(CandidateEntry {
                path: PathBuf::from(format!("C:\\data\\file_{}.tmp", i)),
                size_bytes: (i as u64) * 1000,
                is_dir: false,
                modified_at: 1700000000 + i as u64,
                rule_id: Some("test_rule".to_string()),
            })
            .unwrap();
    }

    assert_eq!(store.len(), 15);
    assert!(
        !store.is_spilled(),
        "Store should remain in-memory below threshold"
    );

    // 2. Insert 10 more items (total 25): crosses threshold (20) and triggers disk spill
    for i in 15..25 {
        store
            .push(CandidateEntry {
                path: PathBuf::from(format!("C:\\data\\file_{}.tmp", i)),
                size_bytes: (i as u64) * 1000,
                is_dir: false,
                modified_at: 1700000000 + i as u64,
                rule_id: Some("test_rule".to_string()),
            })
            .unwrap();
    }

    assert_eq!(store.len(), 25);
    assert!(
        store.is_spilled(),
        "Store should have transitioned to SQLite disk spill"
    );

    // 3. Verify all 25 items retrieved with 100% integrity
    let all_entries = store.read_all().unwrap();
    assert_eq!(all_entries.len(), 25);
    for (idx, entry) in all_entries.iter().enumerate() {
        assert_eq!(
            entry.path,
            PathBuf::from(format!("C:\\data\\file_{}.tmp", idx))
        );
        assert_eq!(entry.size_bytes, (idx as u64) * 1000);
    }

    // 4. Test indexed query by min_size >= 10,000 bytes (indexes 10 to 24 = 15 items)
    let filtered = store.read_by_min_size(10_000).unwrap();
    assert_eq!(filtered.len(), 15);
    for entry in &filtered {
        assert!(entry.size_bytes >= 10_000);
    }
}
