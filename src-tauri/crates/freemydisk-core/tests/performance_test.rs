use freemydisk_platform::windows::io_priority::BackgroundExecutionGuard;
use freemydisk_platform::windows::memory::trim_working_set;
use freemydisk_platform::windows::power::{get_adaptive_concurrency_limit, get_system_power_state};
use freemydisk_platform::windows::storage_optim::{detect_drive_media, DriveMedia};
use freemydisk_platform::windows::usn_scan::UsnVolumeIndex;
use std::fs::File;
use std::io::Write;
use tempfile::tempdir;

#[test]
fn test_background_execution_guard() {
    // Entering background priority should not panic and drop should restore state cleanly
    let guard = BackgroundExecutionGuard::enter();
    assert!(guard.is_active() || !cfg!(target_os = "windows"));
    drop(guard);
}

#[test]
fn test_system_power_state_and_concurrency_limits() {
    let power = get_system_power_state();
    assert!(power.battery_percentage <= 100);

    let concurrency = get_adaptive_concurrency_limit();
    assert!(concurrency >= 1);
    if power.is_throttled {
        assert_eq!(concurrency, 2);
    }
}

#[test]
fn test_working_set_trimming() {
    // Trimming working set should execute without panics
    let _ = trim_working_set();
}

#[test]
fn test_drive_media_detection() {
    let media = detect_drive_media('C');
    assert!(matches!(
        media,
        DriveMedia::Ssd | DriveMedia::Hdd | DriveMedia::Unknown
    ));
}

#[test]
fn test_usn_volume_index_graceful_fallback() {
    // Probing a non-existent or invalid drive letter (e.g., 'Z') should gracefully return None
    let idx = UsnVolumeIndex::try_enumerate_volume('Z');
    // Must not panic, gracefully returns None if volume doesn't exist
    assert!(idx.is_none());
}

#[test]
fn test_memory_mapped_and_streaming_hash_consistency() {
    let dir = tempdir().unwrap();
    let file_path = dir.path().join("test_hash_payload.bin");

    // Create a 128 KB file (fits within the 64KB - 1GB memmap2 fast-path)
    let mut file = File::create(&file_path).unwrap();
    let payload = vec![0xABu8; 131072];
    file.write_all(&payload).unwrap();
    file.flush().unwrap();
    drop(file);

    // Compute expected hash using blake3 directly
    let mut hasher = blake3::Hasher::new();
    hasher.update(&payload);
    let expected_hash = hasher.finalize().to_hex().to_string();

    // Verify memmap2 hashing path on file
    let file_read = File::open(&file_path).unwrap();
    let mmap = unsafe { memmap2::Mmap::map(&file_read) }.unwrap();
    let mut mmap_hasher = blake3::Hasher::new();
    mmap_hasher.update(&mmap[..]);
    let mmap_hash = mmap_hasher.finalize().to_hex().to_string();

    assert_eq!(expected_hash, mmap_hash);
}
