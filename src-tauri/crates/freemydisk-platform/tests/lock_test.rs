use freemydisk_platform::get_platform;
use freemydisk_platform::traits::PlatformFilesystem;
use tempfile::tempdir;

#[test]
fn test_cross_process_lock_acquisition_and_exclusivity() {
    let dir = tempdir().unwrap();
    let lock_path = dir.path().join("test_disposal.lock");
    let platform = get_platform();

    // 1. Acquire primary lock
    let lock_guard1 = platform.acquire_cross_process_lock(&lock_path);
    assert!(
        lock_guard1.is_ok(),
        "First process must acquire lock successfully"
    );

    // 2. Second attempt while lock is held must fail with LockBusy
    let lock_guard2 = platform.acquire_cross_process_lock(&lock_path);
    assert!(
        lock_guard2.is_err(),
        "Second attempt while lock is held must fail"
    );

    // 3. Drop first lock (simulating clean release or termination)
    drop(lock_guard1);

    // 4. Third attempt must succeed immediately
    let lock_guard3 = platform.acquire_cross_process_lock(&lock_path);
    assert!(
        lock_guard3.is_ok(),
        "After releasing, subsequent acquisition must succeed immediately"
    );
}
