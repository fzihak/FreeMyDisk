use freemydisk_platform::io_priority::BackgroundExecutionGuard;
use freemydisk_platform::memory::trim_working_set;
use freemydisk_platform::power::{get_adaptive_concurrency_limit, get_system_power_state};
use freemydisk_platform::storage_optim::{detect_drive_media, DriveMedia};
#[cfg(target_os = "windows")]
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

#[cfg(target_os = "windows")]
#[test]
fn test_usn_volume_index_graceful_fallback() {
    // Probing a non-existent or invalid drive letter (e.g., 'Z') should gracefully return None
    let idx = UsnVolumeIndex::try_enumerate_volume('Z');
    // Must not panic, gracefully returns None if volume doesn't exist
    assert!(idx.is_none());
}

#[test]
fn test_buffered_streaming_hash_matches_in_memory_hash() {
    let dir = tempdir().unwrap();
    let file_path = dir.path().join("test_hash_payload.bin");

    // Larger than the 1 MiB read buffer so the stream is read in several chunks.
    let mut file = File::create(&file_path).unwrap();
    let payload: Vec<u8> = (0..3 * 1024 * 1024 + 17).map(|i| (i % 251) as u8).collect();
    file.write_all(&payload).unwrap();
    file.flush().unwrap();
    drop(file);

    let expected_hash = blake3::hash(&payload).to_hex().to_string();

    let reader = std::io::BufReader::with_capacity(1 << 20, File::open(&file_path).unwrap());
    let mut hasher = blake3::Hasher::new();
    hasher.update_reader(reader).unwrap();

    assert_eq!(expected_hash, hasher.finalize().to_hex().to_string());
}
